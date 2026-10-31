# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""Async DSPy engines and tools over the JavaScript-owned runtime boundary."""

import asyncio
import json
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass, fields
from typing import Any

import dspy
from dspy.lm15 import FunctionTool, Message, Request, Response, TextPart, ToolCallPart, ToolResultPart, Usage

from . import capabilities
from ._bridge import ERROR_MESSAGES, GalaxieError, request


class _LMError(dspy.LMError):
    code: str
    def __init__(self, code: str) -> None:
        error = GalaxieError(code)
        super().__init__(str(error), code=error.code)


class _Termination(BaseException):
    def __init__(self, code: str) -> None:
        self.code = GalaxieError(code).code
        super().__init__(ERROR_MESSAGES[self.code])


@dataclass
class _Run:
    conversation: str
    ordinal: int
    calls: int = 0
    failure: str | None = None

    def record(self, code: str) -> None:
        if self.failure is None:
            self.failure = code

    def check(self) -> None:
        # A failure that DSPy turned into an observation still ends the run with its code.
        if self.failure is not None:
            raise _Termination(self.failure)


_run: ContextVar[_Run | None] = ContextVar('galaxie_dspy_run', default=None)


def _json(value: Any) -> Any:
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, OverflowError, UnicodeError):
        raise GalaxieError('unsupported') from None


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


class _SyncEngine:
    def complete(self, value: Request) -> Response:
        raise _LMError('unsupported')


class _AsyncEngine:
    def __init__(self, role: str, native: bool) -> None:
        self.role, self.native = role, native

    async def complete(self, value: Request) -> Response:
        run = _run.get()
        if run is not None:
            run.check()
        try:
            options = _options(value, self.native)
            reply = await request('model', {'role': self.role, 'messages': _messages(value), 'options': options})
            return _reply(reply, value, self.native, self.role)
        except GalaxieError as error:
            if run is not None:
                run.record(error.code)
            raise _LMError(error.code) from None

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
        raise _LMError('unsupported')

    async def acall(self, prompt: Any = None, *, messages: Any = None, **kwargs: Any) -> Any:
        if kwargs.get('n', self.kwargs.get('n', 1)) != 1:
            raise _LMError('unsupported')
        with dspy.context(disable_history=True, trace=None, callbacks=[]):
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
        ordinal = run.calls
        run.calls += 1
        try:
            return await capabilities.call(name, arguments, effect_scope=f'dspy/{run.conversation}/{run.ordinal}/{ordinal}')
        except GalaxieError as error:
            # Every capability failure ends the run: `invalid` may follow a dispatched write.
            raise _Termination(error.code) from None

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
    for _, predictor in module.named_predictors():
        lm = predictor.lm or default_lm
        if not isinstance(lm, GalaxieLM) or getattr(lm, 'callbacks', []):
            raise GalaxieError('unsupported')


def error_code(error: BaseException) -> str:
    """Flatten task-group failures without exposing author exception text."""
    if isinstance(error, BaseExceptionGroup):
        leaves = []
        def flatten(group: BaseException) -> None:
            if isinstance(group, BaseExceptionGroup):
                for child in group.exceptions:
                    flatten(child)
            else:
                leaves.append(group)
        flatten(error)
        for child in leaves:
            if isinstance(child, (GalaxieError, _LMError, _Termination)):
                return GalaxieError(child.code).code
        return 'cancelled' if all(isinstance(child, asyncio.CancelledError) for child in leaves) else 'executor_error'
    if isinstance(error, (GalaxieError, _LMError, _Termination)):
        return GalaxieError(error.code).code
    return 'cancelled' if isinstance(error, asyncio.CancelledError) else 'executor_error'


class Executor:
    """Map one JSON input to an async DSPy module and project its output fields."""

    def __init__(self, module: dspy.Module, *, input: Callable[[Any], dict[str, Any]] | None = None, output: Callable[[Any], Any] | None = None, adapter: Any = None) -> None:
        if not isinstance(module, dspy.Module):
            raise GalaxieError('unsupported')
        self.module, self.input, self.output = module, input, output
        self.adapter = adapter if adapter is not None else dspy.ChatAdapter(use_json_adapter_fallback=False)
        self.lm = dspy.settings.lm if isinstance(dspy.settings.lm, GalaxieLM) else None
        self._ordinals: dict[str, int] = {}
        _validate(module, self.adapter, self.lm)

    async def run(self, value: Any, conversation: str, steps: int) -> Any:
        dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
        _validate(self.module, self.adapter, self.lm)
        ordinal = self._ordinals.get(conversation, 0) + 1
        self._ordinals[conversation] = ordinal
        run = _Run(conversation, ordinal)
        token = _run.set(run)
        observer = capabilities.failures.set(run.record)
        try:
            inputs = self.input(value) if self.input else value
            if not isinstance(inputs, dict):
                raise GalaxieError('unsupported')
            with dspy.context(lm=self.lm, adapter=self.adapter, disable_history=True, trace=None, callbacks=[]):
                result = await self.module.acall(**inputs)
            run.check()
            if self.output:
                return _json(self.output(result))
            signature = getattr(self.module, 'signature', None)
            return _json({key: result[key] for key in signature.output_fields} if signature is not None else dict(result.items()))
        except BaseException as error:
            raise GalaxieError(error_code(error)) from None
        finally:
            capabilities.failures.reset(observer)
            _run.reset(token)


def prepare_executor(value: Any) -> Executor:
    if isinstance(value, Executor):
        _validate(value.module, value.adapter, value.lm)
        return value
    if isinstance(value, dspy.Module):
        return Executor(value)
    raise GalaxieError('unsupported')
