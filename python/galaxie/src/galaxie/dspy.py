# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Async DSPy engines and tools over the JavaScript-owned runtime boundary."""

import asyncio
import hashlib
import json
import math
import os
import re
import threading
import weakref
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from contextlib import aclosing
from contextvars import ContextVar
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

import dspy
from dspy.lm15 import FunctionTool, Message, Request, Response, StreamDeltaEvent, StreamEndEvent, StreamStartEvent, TextDelta, TextPart, ToolCallDelta, ToolCallPart, ToolResultPart, Usage
from dspy.streaming import StatusMessageProvider, StreamListener, StreamResponse
from dspy.utils.parallelizer import ParallelExecutor

from . import capabilities
from ._bridge import ERROR_MESSAGES, MAX_BYTES, GalaxieError, _model_reply, request


_STATE_BINDING = 'stateBinding'
_RUN_KEY = 'galaxie_run'


def state_binding(root: str | Path) -> str | None:
    """Bind descriptor JSON paths and Python-visible bytes against accidental swaps."""
    root = Path(root)

    def fail(error: OSError) -> None:
        raise error

    try:
        entries = sorted(
            [path.relative_to(root).as_posix(), hashlib.sha256(path.read_bytes()).hexdigest()]
            for directory, names, files in (os.walk(root, onerror=fail) if root.is_dir() else ())
            for path in (Path(directory, name) for name in files)
            if path.suffix == '.json' and '__pycache__' not in path.relative_to(root).parts
        )
        if not entries:
            return None
        return hashlib.sha256(json.dumps(entries, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')).hexdigest()
    except (OSError, UnicodeEncodeError):
        raise GalaxieError('unsupported') from None


class _LMError(dspy.LMError):
    code: str
    def __init__(self, code: str) -> None:
        error = GalaxieError(code)
        super().__init__(str(error), code=error.code)


class _Termination(BaseException):
    def __init__(self, code: str) -> None:
        self.code = GalaxieError(code).code
        super().__init__(ERROR_MESSAGES[self.code])


class _Pause(BaseException):
    def __init__(self, interaction: dict[str, Any]) -> None:
        self.interaction = interaction


@dataclass
class _Session:
    ordinal: int = 0
    pauses: int = 0
    value: Any = None
    journal: list[dict[str, Any]] = field(default_factory=list)
    pending: dict[str, Any] | None = None
    unrecoverable: bool = False

    def bounded(self) -> None:
        encoded = json.dumps(vars(self), ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        # Byte envelopes cross the same bounded bridge as every other message.
        if ((len(encoded) + 2) // 3) * 4 + 4096 > MAX_BYTES:
            raise _Termination('unsupported')


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(_json(value), sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')).hexdigest()


@dataclass
class _BranchProgress:
    calls: int = 0
    busy: bool = False


@dataclass(frozen=True)
class _Branch:
    group: int
    key: str
    index: int


@dataclass
class _Group:
    ordinal: int
    branches: dict[str, _BranchProgress]
    remaining: dict[str, dict[str, Any]]


@dataclass
class _Run:
    conversation: str
    ordinal: int
    session: _Session
    replay: int = 0
    cursor: int = 0
    replay_notified: bool = False
    pausing: bool = False
    streaming: bool = False
    calls: int = 0
    failure: str | None = None
    models: int = 0
    on_stream: Callable[[str, Any], None] | None = None
    groups: int = 0
    group: _Group | None = None

    def record(self, code: str) -> None:
        if self.failure is None:
            self.failure = code

    def check(self) -> None:
        # A failure that DSPy turned into an observation still ends the run with its code.
        if self.failure is not None:
            raise _Termination(self.failure)

    def refuse(self, code: str = 'unsupported') -> Any:
        self.record(code)
        self.check()

    def model(self) -> None:
        self.check()
        if self.streaming:
            self.emit('updates', {'kind': 'model', 'index': self.models})
        self.check()
        self.models += 1

    @property
    def replaying(self) -> bool:
        return self.cursor < self.replay

    def frontier(self) -> None:
        self.check()
        if self.replaying:
            self.record('unrecoverable')
            self.check()
        if self.replay and not self.replay_notified:
            self.replay_notified = True
            self.emit('updates', {'kind': 'replayed', 'count': self.replay})
            self.check()

    def begin(self, kind: str, payload: Any) -> tuple[dict[str, Any], bool]:
        self.check()
        if self.pausing:
            self.record('unsupported')
            self.check()
        branch = _branch.get()
        if branch is not None:
            group = self.group
            if group is None or branch.group != group.ordinal or kind == 'interaction':
                self.refuse()
            assert group is not None
            progress = group.branches[branch.key]
            if progress.busy or progress.calls > 99999:
                self.refuse()
            mark = f'{branch.group}/{branch.key}/{progress.calls}'
            entry = group.remaining.get(mark)
            digest = _digest(payload)
            if entry is not None:
                if entry['kind'] != kind or entry['digest'] != digest or 'result' not in entry:
                    self.refuse('unrecoverable')
                del group.remaining[mark]
                self.cursor += 1
                progress.calls += 1
                progress.busy = True
                return entry, True
            # A persisted group is complete: any missing entry before the
            # replay frontier is divergence, never permission to dispatch.
            if self.replaying:
                self.refuse('unrecoverable')
            self.frontier()
            entry = {'kind': kind, 'digest': digest, 'fanout': mark}
            self.session.journal.append(entry)
            self.cursor += 1
            progress.calls += 1
            progress.busy = True
            return entry, False
        if self.group is not None:
            self.refuse()
        digest = _digest(payload)
        if self.replaying:
            entry = self.session.journal[self.cursor]
            if 'fanout' in entry or entry['kind'] != kind or entry['digest'] != digest or 'result' not in entry:
                self.record('unrecoverable')
                self.check()
            self.cursor += 1
            return entry, True
        self.frontier()
        entry = {'kind': kind, 'digest': digest, **({'request': _json(payload)} if kind == 'interaction' else {})}
        self.session.journal.append(entry)
        self.cursor += 1
        return entry, False

    def finish(self, entry: dict[str, Any] | None) -> None:
        if entry is not None and 'fanout' in entry and self.group is not None:
            self.group.branches[entry['fanout'].split('/')[1]].busy = False

    async def capability(self, payload: dict[str, Any]) -> Any:
        ordinal = self.calls
        if _branch.get() is None:
            self.calls += 1
        entry, replayed = self.begin('capability', {'name': payload['name'], 'input': payload['input']})
        try:
            if replayed:
                return _json(entry['result'])
            tool_name = _tool_name.get()
            if self.streaming and tool_name is not None:
                self.emit('updates', {'kind': 'tool', 'name': tool_name, 'index': ordinal})
            self.check()
            suffix = entry.get('fanout', str(ordinal))
            result = await request('capability', {**payload, 'effectScope': f'dspy/{self.conversation}/{self.ordinal}/{suffix}'})
            self.check()
            entry['result'] = _json(result)
            return result
        except GalaxieError as error:
            self.record(error.code)
            raise _Termination(self.failure or error.code) from None
        finally:
            self.finish(entry)

    def emit(self, mode: str, data: Any) -> None:
        if self.on_stream is not None:
            try:
                self.on_stream(mode, data)
            except BaseException as error:
                # Drain streamify in its owning task before surfacing a notification
                # failure; abandoning its generator strands an anyio cancel scope.
                self.record(error_code(error))
                self.on_stream = None


_run: ContextVar[_Run | None] = ContextVar('galaxie_dspy_run', default=None)
_branch: ContextVar[_Branch | None] = ContextVar('galaxie_dspy_branch', default=None)
_tool_name: ContextVar[str | None] = ContextVar('galaxie_dspy_tool_name', default=None)


def _foreign_run() -> _Run | None:
    handle = dspy.settings.get(_RUN_KEY)
    return handle() if handle is not None else None


def _refuse_foreign() -> None:
    # DSPy's pool copies its settings, but not the run ContextVar.
    if _run.get() is None and (run := _foreign_run()) is not None:
        run.record('unsupported')
        raise _Termination('unsupported')


async def branches(group: Mapping[str, Callable[[], Awaitable[Any]]]) -> dict[str, Any]:
    """Join keyed async branches with deterministic journal identity and scopes."""
    _refuse_foreign()
    run = _run.get()
    if run is None:
        raise GalaxieError('unsupported')
    run.check()
    if run.group is not None or _branch.get() is not None or run.streaming or not isinstance(group, Mapping):
        run.refuse()
    pairs = list(group.items())
    if (len(pairs) > 32
        or any(type(key) is not str or re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', key, re.ASCII) is None or not callable(call) for key, call in pairs)):
        run.refuse()
    keys = [key for key, _ in pairs]
    if len(set(keys)) != len(keys):
        run.refuse()
    if not pairs:
        return {}
    if run.groups >= 1000:
        run.refuse()
    ordinal = run.groups
    run.groups += 1
    remaining = {entry['fanout']: entry for entry in run.session.journal[run.cursor:run.replay]
                 if entry.get('fanout', '').split('/')[0] == str(ordinal)}
    if any(mark.split('/')[1] not in keys for mark in remaining):
        run.refuse('unrecoverable')
    run.group = _Group(ordinal, {key: _BranchProgress() for key in keys}, remaining)
    start = len(run.session.journal)

    async def invoke(index: int, key: str, call: Callable[[], Awaitable[Any]]) -> tuple[Any, BaseException | None]:
        token = _branch.set(_Branch(ordinal, key, index))
        try:
            result = await call()
            if any(mark.split('/')[1] == key for mark in remaining):
                run.refuse('unrecoverable')
            run.check()
            return result, None
        except BaseException as error:
            if isinstance(error, (GalaxieError, _LMError, _Termination)):
                run.record(error_code(error))
            # Ending early is divergence even when the author catches it.
            if any(mark.split('/')[1] == key for mark in remaining):
                run.record('unrecoverable')
            return None, error
        finally:
            _branch.reset(token)

    tasks = [asyncio.create_task(invoke(index, key, call)) for index, (key, call) in enumerate(pairs)]
    try:
        pending = set(tasks)
        while pending:
            _, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            if run.failure is not None:
                break
        if run.failure is not None:
            for task in pending:
                task.cancel()
        outcomes = await asyncio.gather(*tasks)
        run.check()
        for _, error in outcomes:
            if error is not None:
                raise error
        return {key: outcome[0] for key, outcome in zip(keys, outcomes, strict=True)}
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        run.session.journal[start:] = sorted(run.session.journal[start:], key=lambda entry: (
            keys.index(entry['fanout'].split('/')[1]), int(entry['fanout'].split('/')[2])))
        run.group = None


def _json(value: Any) -> Any:
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, OverflowError, UnicodeError):
        raise GalaxieError('unsupported') from None


def _interaction(value: Any) -> dict[str, Any]:
    def valid(item: Any, ancestors: set[int]) -> bool:
        if item is None or type(item) in (str, bool, int):
            return True
        if type(item) is float:
            return math.isfinite(item)
        if type(item) not in (list, dict) or id(item) in ancestors:
            return False
        ancestors = ancestors | {id(item)}
        return all(valid(child, ancestors) for child in item) if type(item) is list else all(
            type(key) is str and valid(child, ancestors) for key, child in item.items()
        )
    if (type(value) is not dict or set(value) != {'surfaceId', 'viewRevision', 'component', 'props'}
        or any(type(value[key]) is not str or not value[key] for key in ('surfaceId', 'viewRevision', 'component'))
        or re.fullmatch(r'[A-Za-z][\w-]*\.[A-Za-z][\w-]*/v\d+', value['component'], re.ASCII) is None
        or type(value['props']) is not dict or not valid(value, set())):
        raise GalaxieError('unsupported')
    return _json(value)


def request_interaction(request: dict[str, Any]) -> dict[str, Any]:
    """Pause the whole program, or return the recorded answer during re-execution."""
    run = _run.get()
    if run is None:
        raise GalaxieError('unsupported')
    run.check()
    if _branch.get() is not None:
        run.refuse()
    try:
        value = _interaction(request)
    except GalaxieError as error:
        # Author tool code must not turn a malformed request into an observation.
        run.record(error.code)
        run.check()
        raise
    entry, replayed = run.begin('interaction', value)
    if replayed:
        return _json(entry['result'])
    unfinished = [previous for previous in run.session.journal[:-1] if 'result' not in previous]
    if unfinished:
        # A dispatched sibling write may still commit; report it as such.
        run.record('outcome_unknown' if any(previous['kind'] == 'capability' for previous in unfinished) else 'unsupported')
        run.check()
    run.pausing = True
    identifier = _digest([run.conversation, run.session.pauses])
    run.session.pauses += 1
    raise _Pause({'id': identifier, 'value': value})


def _text(parts: Any) -> str:
    if any(not isinstance(part, TextPart) or part.continuation for part in parts):
        raise GalaxieError('unsupported')
    return ''.join(part.text for part in parts)


def _call(part: ToolCallPart) -> dict[str, Any]:
    if part.continuation:
        raise GalaxieError('unsupported')
    return {'id': part.id, 'type': 'function', 'function': {'name': part.name, 'arguments': json.dumps(_json(part.input), separators=(',', ':'), ensure_ascii=False)}}


def _messages(value: Request) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    if value.system is not None:
        messages.append({'role': 'system', 'content': value.system if isinstance(value.system, str) else _text(value.system)})
    for message in value.messages:
        if message.continuation:
            raise GalaxieError('unsupported')
        results = [part for part in message.parts if isinstance(part, ToolResultPart)]
        if results:
            if len(results) != len(message.parts):
                raise GalaxieError('unsupported')
            for part in results:
                if part.continuation:
                    raise GalaxieError('unsupported')
                messages.append({'role': 'tool', 'content': _text(part.content), 'tool_call_id': part.id})
        else:
            calls = [part for part in message.parts if isinstance(part, ToolCallPart)]
            if calls and message.role != 'assistant':
                raise GalaxieError('unsupported')
            messages.append({'role': message.role, 'content': _text([part for part in message.parts if not isinstance(part, ToolCallPart)]), **({'toolCalls': [_call(part) for part in calls]} if calls else {})})
    return messages


def _options(value: Request, native: bool) -> dict[str, Any]:
    config = value.config
    if any(getattr(config, field.name) is not None for field in fields(config) if field.name not in {'stop', 'tool_choice'}):
        raise GalaxieError('unsupported')
    options: dict[str, Any] = {}
    if config.stop:
        options['stop'] = list(config.stop)
    if value.tools:
        if not native or any(not isinstance(tool, FunctionTool) for tool in value.tools):
            raise GalaxieError('unsupported')
        options['tools'] = [{'type': 'function', 'function': {'name': tool.name, 'description': tool.description or '', 'parameters': _json(tool.parameters)}} for tool in value.tools if isinstance(tool, FunctionTool)]
    choice = config.tool_choice
    if choice is not None:
        if not native or not value.tools or choice.parallel is not None or len(choice.allowed) > 1:
            raise GalaxieError('unsupported')
        if choice.allowed:
            if choice.mode != 'required':
                raise GalaxieError('unsupported')
            options['toolChoice'] = {'type': 'function', 'function': {'name': choice.allowed[0]}}
        elif choice.mode in {'auto', 'none', 'required'}:
            options['toolChoice'] = choice.mode
        else:
            raise GalaxieError('unsupported')
    return options


def _invalid_json(_: str) -> None:
    raise GalaxieError('invalid')


def _argument_json(value: str) -> str:
    # Match provider JSON normalization without equating booleans and numbers.
    return json.dumps(json.loads(value, parse_int=float, parse_float=float, parse_constant=_invalid_json), sort_keys=True, allow_nan=False)


def _reply(value: Any, original: Request, native: bool, role: str) -> Response:
    calls = value.get('toolCalls', [])
    if calls and not native:
        raise GalaxieError('unsupported')
    offered = {tool.name for tool in original.tools if isinstance(tool, FunctionTool)}
    seen = {part.id for message in original.messages for part in message.parts if isinstance(part, ToolCallPart)}
    parts: list[Any] = [TextPart(value['content'])] if value['content'] or not calls else []
    for call in calls:
        if not 0 < len(call['id']) <= 128 or call['id'] in seen or call['function']['name'] not in offered:
            raise GalaxieError('invalid')
        seen.add(call['id'])
        try:
            arguments = json.loads(call['function']['arguments'], parse_constant=_invalid_json)
        except (TypeError, ValueError):
            raise GalaxieError('invalid') from None
        if not isinstance(arguments, dict):
            raise GalaxieError('invalid')
        parts.append(ToolCallPart(id=call['id'], name=call['function']['name'], input=arguments))
    usage = value.get('usage')
    return Response(id=None, model=role, message=Message(role='assistant', parts=tuple(parts)), finish_reason='tool_call' if calls else 'stop', usage=Usage(**usage) if usage else Usage())


class _TextFramer:
    # DSPy's listener retains only ten fragments of a delimiter. Frame a delimiter
    # as one fragment, without changing checked text or parsing field values here.
    def __init__(self) -> None:
        self._pending: list[str] = []
        self._suffix = 0

    def feed(self, text: str) -> list[str]:
        prefix, suffix = '[[ ## ', ' ## ]]'
        output, plain = [], []
        for character in text:
            if self._pending:
                if len(self._pending) < len(prefix):
                    valid = character == prefix[len(self._pending)]
                elif self._suffix:
                    valid = character == suffix[self._suffix]
                    if valid:
                        self._suffix += 1
                else:
                    valid = re.fullmatch(r'\w', character) is not None
                    if character == ' ' and len(self._pending) > len(prefix):
                        valid = True
                        self._suffix = 1
                if valid:
                    self._pending.append(character)
                    if self._suffix == len(suffix):
                        output.append(''.join(self._pending))
                        self._pending.clear()
                        self._suffix = 0
                    continue
                plain.extend(self._pending)
                self._pending.clear()
                self._suffix = 0
            if character == '[':
                if plain:
                    output.append(''.join(plain))
                    plain.clear()
                self._pending.append(character)
            else:
                plain.append(character)
        if plain:
            output.append(''.join(plain))
        return output

    def finish(self) -> str:
        text = ''.join(self._pending)
        self._pending.clear()
        self._suffix = 0
        return text


class _SyncEngine:
    def complete(self, value: Request) -> Response:
        _refuse_foreign()
        raise _LMError('unsupported')


class _AsyncEngine:
    def __init__(self, role: str, native: bool) -> None:
        self.role, self.native = role, native

    async def complete(self, value: Request) -> Response:
        _refuse_foreign()
        run = _run.get()
        entry = None
        try:
            options = _options(value, self.native)
            payload = {'role': self.role, 'messages': _messages(value), 'options': options}
            entry, replayed = run.begin('model', payload) if run is not None else ({}, False)
            if replayed:
                if run is not None:
                    run.models += 1
                return _reply(_json(entry['result']), value, self.native, self.role)
            if run is not None:
                run.model()
            reply = await request('model', payload)
            result = _reply(reply, value, self.native, self.role)
            if run is not None:
                run.check()
                entry['result'] = _json(reply)
            return result
        except GalaxieError as error:
            if run is not None:
                run.record(error.code)
            raise _LMError(error.code) from None
        finally:
            if run is not None:
                run.finish(entry)

    async def stream(self, value: Request) -> AsyncIterator[Any]:
        _refuse_foreign()
        run = _run.get()
        entry = None
        task = None
        try:
            options = _options(value, self.native)
            payload = {'role': self.role, 'messages': _messages(value), 'options': options}
            entry, replayed = run.begin('model', payload) if run is not None else ({}, False)
            if replayed:
                raise GalaxieError('unsupported')
            if run is not None:
                run.model()
            chunks: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
            payload = {**payload, 'options': {**options, 'stream': True}}
            async def receive() -> Any:
                try:
                    return await request('model', payload, on_model_chunk=chunks.put_nowait)
                except GalaxieError as error:
                    if run is not None:
                        run.record(error.code)
                    raise
            task = asyncio.create_task(receive())
            task.add_done_callback(lambda _: chunks.put_nowait(None))
            yield StreamStartEvent(model=self.role)
            content: list[str] = []
            calls: dict[int, dict[str, list[str]]] = {}
            framer = _TextFramer()
            while (chunk := await chunks.get()) is not None:
                content.append(chunk['content'])
                for fragment in framer.feed(chunk['content']):
                    yield StreamDeltaEvent(TextDelta(fragment))
                for fragment in chunk.get('toolCalls', []):
                    call = calls.setdefault(fragment['index'], {'id': [], 'name': [], 'arguments': []})
                    call['id'].append(fragment.get('id', ''))
                    for key in ('name', 'arguments'):
                        call[key].append(fragment['function'].get(key, ''))
            final = await task
            reply = _reply(final, value, self.native, self.role)
            joined = [{key: ''.join(pieces) for key, pieces in call.items()} for call in calls.values()]
            by_id = {call['id']: call for call in joined}
            if ''.join(content) != final['content'] or len(joined) != len(final.get('toolCalls', [])) or len(by_id) != len(joined):
                raise GalaxieError('invalid')
            if tail := framer.finish():
                yield StreamDeltaEvent(TextDelta(tail))
            for index, part in enumerate(reply.message.parts):
                if not isinstance(part, ToolCallPart):
                    continue
                streamed = by_id.get(part.id)
                if streamed is None or streamed['name'] != part.name:
                    raise GalaxieError('invalid')
                try:
                    arguments = _argument_json(streamed['arguments'])
                except (ValueError, TypeError):
                    raise GalaxieError('invalid') from None
                if arguments != _argument_json(json.dumps(part.input)):
                    raise GalaxieError('invalid')
                yield StreamDeltaEvent(ToolCallDelta(input=streamed['arguments'], part_index=index, id=part.id, name=part.name))
            if run is not None:
                run.check()
                entry['result'] = _json(final)
            yield StreamEndEvent(finish_reason=reply.finish_reason, usage=reply.usage)
        except GalaxieError as error:
            if run is not None:
                run.record(error.code)
            raise _LMError(error.code) from None
        finally:
            if run is not None:
                run.finish(entry)
            if task is not None:
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def aclose(self) -> None:
        pass


class GalaxieLM(dspy.LM):
    """Use a routed JavaScript model role; DSPy never owns a connection."""

    def __init__(self, role: str, native_tools: bool = False) -> None:
        if not isinstance(role, str) or not role or type(native_tools) is not bool:
            raise GalaxieError('invalid')
        self.role, self.native_tools = role, native_tools
        super().__init__(role, engine=_SyncEngine(), async_engine=_AsyncEngine(role, native_tools), cache=False, num_retries=0, temperature=None, max_tokens=None)

    @property
    def supports_function_calling(self) -> bool:
        return self.native_tools

    @property
    def supports_response_schema(self) -> bool:
        return False

    @property
    def supports_reasoning(self) -> bool:
        return False

    @property
    def supported_params(self) -> set[str]:
        return {'stop', 'tool_choice'} if self.native_tools else {'stop'}

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        _refuse_foreign()
        run = _run.get()
        if run is not None:
            run.check()
            run.record('unsupported')
        raise _LMError('unsupported')

    async def acall(self, prompt: Any = None, *, messages: Any = None, **kwargs: Any) -> Any:
        _refuse_foreign()
        run = _run.get()
        if run is not None:
            run.check()
        if kwargs.get('n', self.kwargs.get('n', 1)) != 1:
            if run is not None:
                run.record('unsupported')
            raise _LMError('unsupported')
        # Reuse the complete path for cached responses: no deltas enter DSPy's
        # asynchronous listener queue, even when the original call streamed.
        replay = {'send_stream': None} if run is not None and run.replaying else {}
        with dspy.context(disable_history=True, trace=None, callbacks=[], **replay):
            return await super().acall(prompt, messages=messages, **kwargs)


def capability_tool(name: str, description: str, args_schema: dict[str, Any], *, tool_name: str | None = None) -> dspy.Tool:
    """Bind a DSPy tool to a broker capability, preserving terminal failures."""
    if not isinstance(name, str) or not name or not isinstance(args_schema, dict) or args_schema.get('type') != 'object':
        raise GalaxieError('invalid')

    async def invoke(**arguments: Any) -> Any:
        run = _run.get()
        if run is None:
            raise _Termination('unsupported')
        run.check()
        token = _tool_name.set(tool_name or name)
        try:
            return await capabilities.call(name, arguments, tool=True)
        except GalaxieError as error:
            # Every capability failure ends the run: `invalid` may follow a dispatched write.
            raise _Termination(error.code) from None
        finally:
            _tool_name.reset(token)

    return dspy.Tool(invoke, name=tool_name or name, desc=description, args=_json(args_schema.get('properties', {})), arg_types={})


def _validate(module: dspy.Module, adapter: Any, default_lm: Any) -> None:
    if not callable(getattr(module, 'aforward', None)):
        raise GalaxieError('unsupported')
    fallback = isinstance(adapter, dspy.ChatAdapter) and not isinstance(adapter, dspy.JSONAdapter) and adapter.use_json_adapter_fallback
    if not isinstance(adapter, (dspy.ChatAdapter, dspy.JSONAdapter)) or fallback or getattr(adapter, 'callbacks', []):
        raise GalaxieError('unsupported')
    for _, child in module.named_sub_modules():
        if getattr(child, 'callbacks', []):
            raise GalaxieError('unsupported')
        for value in vars(child).values():
            values = value.values() if isinstance(value, dict) else value if isinstance(value, (list, tuple)) else ()
            if any(isinstance(item, (dspy.Parallel, dspy.Evaluate, ParallelExecutor)) for item in (value, *values)):
                raise GalaxieError('unsupported')
    for _, predictor in module.named_predictors():
        lm = predictor.lm or default_lm
        if not isinstance(lm, GalaxieLM) or getattr(lm, 'callbacks', []):
            raise GalaxieError('unsupported')


def _exception_leaves(error: BaseException) -> list[BaseException]:
    if isinstance(error, BaseExceptionGroup):
        return [leaf for child in error.exceptions for leaf in _exception_leaves(child)]
    return [error]


def _thread_start_failed(error: BaseException) -> bool:
    for leaf in _exception_leaves(error):
        if isinstance(leaf, RuntimeError):
            traceback = leaf.__traceback__
            while traceback is not None:
                if traceback.tb_frame.f_code is threading.Thread.start.__code__:
                    return True
                traceback = traceback.tb_next
    return False


def error_code(error: BaseException) -> str:
    """Flatten task-group failures without exposing author exception text."""
    if isinstance(error, BaseExceptionGroup):
        leaves = _exception_leaves(error)
        for child in leaves:
            if isinstance(child, (GalaxieError, _LMError, _Termination)):
                return GalaxieError(child.code).code
        return 'cancelled' if all(isinstance(child, asyncio.CancelledError) for child in leaves) else 'executor_error'
    if isinstance(error, (GalaxieError, _LMError, _Termination)):
        return GalaxieError(error.code).code
    return 'cancelled' if isinstance(error, asyncio.CancelledError) else 'executor_error'


def _pause(error: BaseException) -> _Pause | None:
    leaves = _exception_leaves(error)
    failures = [item for item in leaves if isinstance(item, (GalaxieError, _LMError, _Termination))]
    if failures:
        raise GalaxieError(failures[0].code)
    pauses = [item for item in leaves if isinstance(item, _Pause)]
    if len(pauses) > 1:
        raise GalaxieError('unsupported')
    if len(pauses) == 1 and all(isinstance(item, (_Pause, asyncio.CancelledError)) for item in leaves):
        return pauses[0]
    return None


class _SilentStatus(StatusMessageProvider):
    def tool_start_status_message(self, instance: Any, inputs: Any) -> Any:
        pass

    def tool_end_status_message(self, outputs: Any) -> Any:
        pass


class _ChatListener(StreamListener):
    _LINE_BREAKS = '\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029'

    def __init__(self, field: str, **kwargs: Any) -> None:
        super().__init__(field, **kwargs)
        self._line_start = True
        self._indented = False
        self._header = False
        self._carriage_return = False

    def receive(self, chunk: Any) -> Any:
        choice = chunk.choices[0]
        text = choice.delta.content
        if text is None:
            if choice.finish_reason is not None:
                # Reuse is per model call; repeated field headers within a call
                # still keep the first value, as ChatAdapter.parse does.
                self.__init__(self.signature_field_name, predict=self.predict, predict_name=self.predict_name)
            return None
        if self.stream_end:
            return None
        self._header = self._line_start and re.fullmatch(r'\[\[ ## \w+ ## \]\]', text) is not None
        if self._header and self._indented and not self.stream_start and text == f'[[ ## {self.signature_field_name} ## ]]':
            # ChatAdapter.parse slices an indented header's value differently;
            # leave that field to the final output rather than stream other text.
            self.stream_end = True
            return None
        consume = self.stream_start or bool(self.field_start_queue) or (
            self._header and text == f'[[ ## {self.signature_field_name} ## ]]'
        )
        for character in text:
            if character in self._LINE_BREAKS:
                self._line_start, self._indented = True, False
            elif not character.isspace():
                self._line_start = False
            elif self._line_start:
                self._indented = True
        return super().receive(chunk) if consume else None

    def _could_form_end_identifier(self, concat_message: str, adapter_name: str) -> bool:
        return self._header

    def flush(self) -> str:
        # DSPy's default flush truncates literal '[['; only framed line headers
        # delimit ChatAdapter fields. The engine frames those before streamify.
        text = ''.join(self.field_end_queue.get_nowait() for _ in range(self.field_end_queue.qsize()))
        if self._header:
            text = text.split('[[ ##', 1)[0]
        normalized = []
        for character in text:
            if character == '\n' and self._carriage_return:
                self._carriage_return = False
                continue
            self._carriage_return = character == '\r'
            normalized.append('\n' if character in self._LINE_BREAKS else character)
        if self._header:
            self._carriage_return = False
        return ''.join(normalized)


class Executor:
    """Map one JSON input to an async DSPy module and project its output fields."""

    def __init__(self, module: dspy.Module, *, input: Callable[[Any], dict[str, Any]] | None = None, output: Callable[[Any], Any] | None = None, adapter: Any = None, stream_fields: Sequence[str] = ()) -> None:
        if not isinstance(module, dspy.Module):
            raise GalaxieError('unsupported')
        self.module, self.input, self.output = module, input, output
        self.adapter = adapter if adapter is not None else dspy.ChatAdapter(use_json_adapter_fallback=False)
        self.lm = dspy.settings.lm if isinstance(dspy.settings.lm, GalaxieLM) else None
        self._sessions: dict[str, _Session] = {}
        self._state_binding: str | None = None
        if isinstance(stream_fields, str) or any(not isinstance(field, str) or not field for field in stream_fields) or len(set(stream_fields)) != len(stream_fields):
            raise GalaxieError('unsupported')
        self.stream_fields = tuple(stream_fields)
        _validate(module, self.adapter, self.lm)

    def pending(self, conversation: str) -> dict[str, Any] | None:
        state = self._sessions.get(conversation)
        if state is not None and state.unrecoverable:
            raise GalaxieError('unrecoverable')
        return _json(state.pending) if state is not None and state.pending else None

    def _snapshot(self, conversation: str, session: str, *, compact: bool = False) -> tuple[bytes, bytes]:
        state = self._sessions[conversation]
        if compact and state.pending is not None:
            raise GalaxieError('unsupported')
        checkpoint = {
            'conversation_id': conversation, 'ordinal': state.ordinal, 'pauses': state.pauses,
            'input': None if compact else state.value, 'journal': [] if compact else state.journal,
            'status': 'unrecoverable' if state.unrecoverable else 'paused' if state.pending else 'completed',
        }
        metadata = {'v': 1, 'dspy': dspy.__version__, 'adapter': type(self.adapter).__name__, 'session': session}
        if self._state_binding is not None and checkpoint['status'] == 'paused':
            metadata[_STATE_BINDING] = self._state_binding
        def encode(value: Any) -> bytes:
            return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        return encode(checkpoint), encode(metadata)

    def _restore(self, checkpoint: bytes, metadata: bytes, session: str) -> str:
        """Validate a session-bound journal and derive its pending request from the frontier."""
        try:
            raw, meta = json.loads(checkpoint), json.loads(metadata)
            keys = {'v', 'dspy', 'adapter', 'session'}
            if (type(meta) is not dict or set(meta) not in (keys, keys | {_STATE_BINDING})
                or type(meta['v']) is not int or meta['v'] != 1
                or meta['dspy'] != dspy.__version__ or meta['adapter'] != type(self.adapter).__name__
                or meta['session'] != session
                or type(raw) is not dict or set(raw) != {'conversation_id', 'ordinal', 'pauses', 'input', 'journal', 'status'}
                or type(raw['conversation_id']) is not str or not raw['conversation_id']
                or type(raw['ordinal']) is not int or raw['ordinal'] < 1
                or type(raw['pauses']) is not int or raw['pauses'] < 0
                or type(raw['journal']) is not list or raw['status'] not in {'paused', 'completed', 'unrecoverable'}):
                raise ValueError()
            if _STATE_BINDING in meta:
                binding = meta[_STATE_BINDING]
                if (raw['status'] != 'paused' or type(binding) is not str
                    or re.fullmatch('[0-9a-f]{64}', binding) is None or binding != self._state_binding):
                    raise ValueError()
            identifier = raw['conversation_id']
            state = _Session(ordinal=raw['ordinal'], pauses=raw['pauses'], value=raw['input'], journal=raw['journal'], unrecoverable=raw['status'] == 'unrecoverable')
            interactions = 0
            last_group = -1
            group_closed = False
            counts: dict[str, int] = {}
            for index, entry in enumerate(state.journal):
                if type(entry) is not dict or entry.get('kind') not in {'model', 'capability', 'interaction'}:
                    raise ValueError()
                pending = raw['status'] == 'paused' and index == len(state.journal) - 1
                expected = {'kind', 'digest'} | ({'request'} if entry['kind'] == 'interaction' else set()) | (set() if pending else {'result'})
                if 'fanout' in entry:
                    marker = entry['fanout']
                    if (entry['kind'] not in {'model', 'capability'} or type(marker) is not str
                        or re.fullmatch(r'(?:0|[1-9][0-9]{0,2})/[A-Za-z0-9_.-]{1,64}/(?:0|[1-9][0-9]{0,4})', marker, re.ASCII) is None):
                        raise ValueError()
                    group, key, number = marker.split('/')
                    if int(group) != last_group:
                        if int(group) <= last_group:
                            raise ValueError()
                        last_group, group_closed, counts = int(group), False, {}
                    if group_closed or int(number) != counts.get(key, 0):
                        raise ValueError()
                    counts[key] = int(number) + 1
                    if len(counts) > 32:
                        raise ValueError()
                    expected |= {'fanout'}
                else:
                    group_closed = True
                if set(entry) != expected or type(entry['digest']) is not str or re.fullmatch('[0-9a-f]{64}', entry['digest']) is None:
                    raise ValueError()
                if entry['kind'] == 'interaction':
                    interactions += 1
                    value = _interaction(entry['request'])
                    if _digest(value) != entry['digest']:
                        raise ValueError()
                    if pending:
                        state.pending = {'id': _digest([identifier, state.pauses - 1]), 'value': value}
                    elif (type(entry['result']) is not dict or set(entry['result']) != {'action', 'payload'}
                        or type(entry['result']['action']) is not str or not entry['result']['action']):
                        raise ValueError()
                elif pending:
                    raise ValueError()
                elif entry['kind'] == 'model':
                    # Shape-only check; replay compares the live request digest before use.
                    if not _model_reply(entry['result']):
                        raise ValueError()
            if (interactions > state.pauses or (raw['status'] == 'paused' and state.pending is None)
                or (state.unrecoverable and (state.journal or state.value is not None))):
                raise ValueError()
            state.bounded()
            _json(raw)
            if raw['status'] == 'completed':
                state.journal = []
                state.value = None
            self._sessions[identifier] = state
            return identifier
        except Exception:
            raise GalaxieError('unrecoverable') from None
        except _Termination:
            raise GalaxieError('unrecoverable') from None

    async def _stream_prediction(self, inputs: dict[str, Any], run: _Run) -> Any:
        if type(self.adapter) is not dspy.ChatAdapter:
            raise GalaxieError('unsupported')
        listeners = []
        for field in self.stream_fields:
            predictors = [predictor for _, predictor in self.module.named_predictors() if field in getattr(predictor.signature, 'output_fields', {})]
            if len(predictors) != 1 or getattr(predictors[0].signature, 'output_fields')[field].annotation is not str:
                raise GalaxieError('unsupported')
            listeners.append(_ChatListener(field))
        stream: Any = dspy.streamify(self.module, is_async_program=True, async_streaming=True,
            stream_listeners=listeners, status_message_provider=_SilentStatus())
        result = None
        async with aclosing(stream(**inputs)) as events:
            async for item in events:
                if isinstance(item, StreamResponse) and item.signature_field_name in self.stream_fields:
                    if not isinstance(item.chunk, str):
                        raise GalaxieError('unsupported')
                    if item.chunk:
                        run.emit('messages', {'field': item.signature_field_name, 'text': item.chunk})
                elif isinstance(item, dspy.Prediction):
                    result = item
        if result is None:
            raise GalaxieError('executor_error')
        return result

    async def run(self, value: Any, conversation: str, steps: int, *, on_stream: Callable[[str, Any], None] | None = None, resume: dict[str, Any] | None = None) -> Any:
        dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
        _validate(self.module, self.adapter, self.lm)
        state = self._sessions.setdefault(conversation, _Session())
        if state.unrecoverable:
            raise GalaxieError('unrecoverable')
        if resume is not None:
            if state.pending is None or resume.get('interactionId') != state.pending['id']:
                raise GalaxieError('stale')
            if set(resume) != {'interactionId', 'action', 'payload'} or not isinstance(resume['action'], str) or not resume['action']:
                raise GalaxieError('invalid')
            state.journal[-1]['result'] = _json({'action': resume['action'], 'payload': resume['payload']})
            replay = len(state.journal)
        else:
            # Core decides whether a fresh start may replace a pending pause
            # (for example after it rejected the published request).
            state.ordinal += 1
            state.value = _json(value)
            state.journal = []
            replay = 0
        state.pending = None
        streaming = on_stream is not None and bool(self.stream_fields)
        run = _Run(conversation, state.ordinal, state, replay=replay, streaming=streaming, on_stream=on_stream)
        token = _run.set(run)
        observer = capabilities.failures.set(run.record)
        dispatcher = capabilities.dispatch.set(run.capability)
        try:
            state.bounded()
            value = _json(state.value)
            inputs = self.input(value) if self.input else value
            if not isinstance(inputs, dict):
                raise GalaxieError('unsupported')
            with dspy.context(lm=self.lm, adapter=self.adapter, disable_history=True, trace=None, callbacks=[], **{_RUN_KEY: weakref.ref(run)}):
                if streaming:
                    result = await self._stream_prediction(inputs, run)
                else:
                    result = await self.module.acall(**inputs)
            run.frontier()
            if run.pausing:
                raise GalaxieError('unsupported')
            if self.output:
                output = _json(self.output(result))
            else:
                signature = getattr(self.module, 'signature', None)
                output = _json({key: result[key] for key in signature.output_fields} if signature is not None else dict(result.items()))
            run.check()
            return output
        except BaseException as error:
            try:
                run.check()
                pause = _pause(error)
                if pause is not None:
                    run.frontier()
                    state.pending = pause.interaction
                    state.bounded()
                    run.emit('updates', {'kind': 'pause'})
                    run.check()
                    return None
                code = error_code(error)
                if code == 'executor_error' and _thread_start_failed(error):
                    code = 'unsupported'
            except BaseException as terminal:
                code = run.failure or error_code(terminal)
            state.pending = None
            state.journal = []
            state.value = None
            if code == 'unrecoverable':
                state.unrecoverable = True
                run.emit('updates', {'kind': 'unrecoverable'})
            raise GalaxieError(code) from None
        finally:
            capabilities.dispatch.reset(dispatcher)
            capabilities.failures.reset(observer)
            _run.reset(token)


def prepare_executor(value: Any, *, state_binding: str | None = None) -> Executor:
    if state_binding is not None and (type(state_binding) is not str or re.fullmatch('[0-9a-f]{64}', state_binding) is None):
        raise GalaxieError('unsupported')
    if isinstance(value, Executor):
        _validate(value.module, value.adapter, value.lm)
    elif isinstance(value, dspy.Module):
        value = Executor(value)
    else:
        raise GalaxieError('unsupported')
    value._state_binding = state_binding
    return value
