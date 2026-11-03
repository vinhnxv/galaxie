# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""Google ADK agents, models and capability tools backed by the JavaScript runtime."""

import asyncio
import contextlib
import copy
import json
import logging
import re
import secrets
import warnings
import weakref
from collections.abc import AsyncGenerator, Callable, Iterator
from contextvars import ContextVar
from typing import Any

from google.adk.agents import BaseAgent, LlmAgent, LoopAgent, ParallelAgent, SequentialAgent
from google.adk.agents.run_config import RunConfig, StreamingMode  # pyright: ignore[reportPrivateImportUsage]
from google.adk.apps import App
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.plugins import ToolCallIntegrityPlugin
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import FunctionTool, exit_loop
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext
from google.genai import types
from pydantic import BaseModel, TypeAdapter
from pydantic_core import to_jsonable_python

from . import capabilities
from ._bridge import ERROR_MESSAGES, GalaxieError, request

APP_NAME = 'galaxie'
USER_ID = 'galaxie'
MAX_DEPTH = 16
MAX_AGENTS = 256
# The longest text one `messages` event carries; a longer delta is split.
MAX_DELTA = 4096
_TOOL_NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,63}$')
# A capability error that tells the model about its own mistake rather than ending the run.
_MODEL_VISIBLE = frozenset({'denied', 'invalid'})
# In-process tools ADK adds to a request itself; none of them reaches the network.
_INTERNAL_TOOLS = frozenset({'transfer_to_agent', 'set_model_response', 'finish_task'})
# Settings that start behavior galaxie does not govern; anything but the default fails closed.
_REFUSED_FIELDS = (
    'parallel_worker', 'wait_for_output', 'timeout', 'retry_config', 'state_schema',
    'input_schema', 'rerun_on_resume',
)
_NUMERIC_LIMITS = (
    'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties',
    'maxProperties',
)
_COPIED = ('description', 'title', 'format', 'pattern', 'enum', 'default')
_DEPTH_LIMIT = 32


class _Run:
    """The state of one run: the step budget, the fatal-failure slot and the call-ID counter."""

    def __init__(self, steps: int, conversation: str, seeded: int) -> None:
        self.steps = steps
        self.conversation = conversation
        self.calls = 0
        self.failure: GalaxieError | None = None
        self.next_call = seeded
        # Capability tools dispatch one at a time, so a fatal failure stops the siblings.
        self.lock = asyncio.Lock()

    def fail(self, error: BaseException | None, code: str = 'executor_error') -> GalaxieError:
        """Record the first fatal failure and return it."""
        if self.failure is None:
            self.failure = _galaxie_error(error) or GalaxieError(code)
        return self.failure

    def take_call_id(self) -> str:
        self.next_call += 1
        return f'galaxie-{self.next_call}'


_active: ContextVar[_Run | None] = ContextVar('galaxie_adk_run', default=None)


class _Registry:
    """Objects this module created; membership, not an attribute an author can copy, is the trust."""

    def __init__(self) -> None:
        self._refs: dict[int, weakref.ReferenceType[Any]] = {}

    def add(self, value: Any) -> None:
        key = id(value)
        self._refs[key] = weakref.ref(value, lambda _, key=key: self._refs.pop(key, None))

    def __contains__(self, value: object) -> bool:
        reference = self._refs.get(id(value))
        return reference is not None and reference() is value


_models = _Registry()
_tools = _Registry()


def _galaxie_error(error: BaseException | None) -> GalaxieError | None:
    """The galaxie error an exception carries, directly or through ADK's wrapping."""
    seen: set[int] = set()
    while error is not None and id(error) not in seen:
        if isinstance(error, GalaxieError):
            return error
        seen.add(id(error))
        error = error.__cause__ or error.__context__
    return None


def _json(value: Any) -> Any:
    try:
        return json.loads(json.dumps(to_jsonable_python(value), allow_nan=False, ensure_ascii=False))
    except (ValueError, TypeError, OverflowError):
        raise GalaxieError('unsupported') from None


def _object(value: Any) -> bool:
    return isinstance(value, dict)


def _convert(schema: Any, depth: int) -> dict[str, Any]:
    """A Gemini-style schema, in its JSON form, as the JSON Schema a provider enforces."""
    if not _object(schema) or depth > _DEPTH_LIMIT:
        raise GalaxieError('invalid')
    result: dict[str, Any] = {key: schema[key] for key in _COPIED if schema.get(key) is not None}
    # Gemini marks string enums with a format that JSON Schema does not define.
    if result.get('format') == 'enum':
        del result['format']
    for key in _NUMERIC_LIMITS:
        limit = schema.get(key)
        if limit is None:
            continue
        try:
            number = float(limit) if isinstance(limit, str) else limit
            if isinstance(number, bool) or not isinstance(number, (int, float)) or number != number:
                raise ValueError()
        except ValueError:
            raise GalaxieError('invalid') from None
        result[key] = int(number) if float(number).is_integer() else number
    kind = schema.get('type')
    if kind is not None:
        if not isinstance(kind, str) or kind.lower() not in (
            'object', 'string', 'number', 'integer', 'boolean', 'array', 'null',
        ):
            raise GalaxieError('invalid')
        result['type'] = kind.lower()
    properties = schema.get('properties')
    if properties is not None:
        if not _object(properties):
            raise GalaxieError('invalid')
        result['properties'] = {name: _convert(item, depth + 1) for name, item in properties.items()}
    required = schema.get('required')
    if required is not None:
        if not isinstance(required, list) or not all(isinstance(name, str) for name in required):
            raise GalaxieError('invalid')
        result['required'] = required
    if schema.get('items') is not None:
        result['items'] = _convert(schema['items'], depth + 1)
    variants = schema.get('anyOf')
    if variants is not None:
        if not isinstance(variants, list):
            raise GalaxieError('invalid')
        result['anyOf'] = [_convert(variant, depth + 1) for variant in variants]
    if schema.get('nullable') is True:
        return {'anyOf': [result, {'type': 'null'}]}
    return result


def _declaration_parameters(declaration: types.FunctionDeclaration) -> dict[str, Any]:
    if declaration.parameters_json_schema is not None:
        if not _object(declaration.parameters_json_schema):
            raise GalaxieError('invalid')
        return _json(declaration.parameters_json_schema)
    if declaration.parameters is None:
        return {'type': 'object', 'properties': {}}
    return _convert(declaration.parameters.model_dump(mode='json', by_alias=True, exclude_none=True), 0)


def _response_schema(config: types.GenerateContentConfig) -> dict[str, Any] | None:
    """The JSON Schema a request's structured output must follow, if it asks for one."""
    if config.response_json_schema is not None:
        if not _object(config.response_json_schema):
            raise GalaxieError('invalid')
        return _json(config.response_json_schema)
    schema = config.response_schema
    if schema is None:
        return None
    if isinstance(schema, types.Schema):
        return _convert(schema.model_dump(mode='json', by_alias=True, exclude_none=True), 0)
    if _object(schema):
        return _json(schema)
    try:
        if isinstance(schema, type) and issubclass(schema, BaseModel):
            return _json(schema.model_json_schema())
        return _json(TypeAdapter(schema).json_schema())
    except GalaxieError:
        raise
    except Exception:
        raise GalaxieError('unsupported') from None


def _instruction_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return '\n'.join(_instruction_text(item) for item in value)
    if isinstance(value, types.Content):
        return '\n'.join(_instruction_text(part) for part in value.parts or [])
    if isinstance(value, types.Part):
        return _part_text(value)
    raise GalaxieError('unsupported')


def _part_text(part: types.Part) -> str:
    """The text of a plain text part; any other kind of part is not something galaxie sends."""
    known = {key for key, item in part.model_dump(exclude_none=True).items()}
    if known - {'text', 'thought', 'thought_signature'}:
        raise GalaxieError('unsupported')
    return '' if part.thought is True or part.text is None else part.text


def _call_id(value: str | None) -> str:
    if not isinstance(value, str) or not value or len(value) > 128:
        raise GalaxieError('invalid')
    return value


def _messages(llm_request: LlmRequest) -> list[dict[str, Any]]:
    """ADK turns as chat messages in OpenAI order: system, then user, assistant and tool messages."""
    messages: list[dict[str, Any]] = []
    config = llm_request.config
    if config is not None and config.system_instruction is not None:
        text = _instruction_text(config.system_instruction)
        if text:
            messages.append({'role': 'system', 'content': text})
    for content in llm_request.contents:
        parts = content.parts or []
        if content.role == 'model':
            calls = []
            texts = []
            for part in parts:
                if part.function_call is not None:
                    call = part.function_call
                    if not isinstance(call.name, str) or not call.name:
                        raise GalaxieError('invalid')
                    calls.append({
                        'id': _call_id(call.id), 'type': 'function',
                        'function': {
                            'name': call.name,
                            'arguments': json.dumps(_json(call.args or {}), separators=(',', ':'), ensure_ascii=False, allow_nan=False),
                        },
                    })
                else:
                    texts.append(_part_text(part))
            messages.append({'role': 'assistant', 'content': ''.join(texts), **({'toolCalls': calls} if calls else {})})
            continue
        texts = []
        for part in parts:
            if part.function_response is not None:
                response = part.function_response
                messages.append({
                    'role': 'tool', 'tool_call_id': _call_id(response.id),
                    'content': json.dumps(_json(response.response or {}), separators=(',', ':'), ensure_ascii=False, allow_nan=False),
                })
            else:
                texts.append(_part_text(part))
        if ''.join(texts):
            messages.append({'role': 'user', 'content': ''.join(texts)})
    return messages


def _tool_definitions(llm_request: LlmRequest) -> list[dict[str, Any]]:
    """Gemini-style function declarations as OpenAI-format tools."""
    tools: list[dict[str, Any]] = []
    configured = llm_request.config.tools if llm_request.config is not None else None
    for tool in configured or []:
        if not isinstance(tool, types.Tool):
            raise GalaxieError('invalid')
        if tool.model_dump(exclude_none=True).keys() - {'function_declarations'}:
            raise GalaxieError('unsupported')
        for declaration in tool.function_declarations or []:
            if not declaration.name or any(known['function']['name'] == declaration.name for known in tools):
                raise GalaxieError('invalid')
            tools.append({'type': 'function', 'function': {
                'name': declaration.name, 'description': declaration.description or '',
                'parameters': _declaration_parameters(declaration),
            }})
    return tools


class _GalaxieLlm(BaseLlm):
    """The router-backed ADK model: every call is leased through the JavaScript runtime."""

    role: str

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False,
    ) -> AsyncGenerator[LlmResponse, None]:
        run = _active.get()
        if run is None:
            raise GalaxieError('invalid')
        try:
            # After a fatal error nothing more may reach a provider or the model.
            if run.failure is not None:
                raise run.failure
            for name, tool in llm_request.tools_dict.items():
                if tool not in _tools and name not in _INTERNAL_TOOLS:
                    raise GalaxieError('unsupported')
            if run.calls >= run.steps:
                raise GalaxieError('budget_exceeded')
            run.calls += 1
            messages = _messages(llm_request)
            tools = _tool_definitions(llm_request)
            offered = {tool['function']['name'] for tool in tools}
            config = llm_request.config
            schema = _response_schema(config) if config is not None else None
            stop = list(config.stop_sequences or []) if config is not None else []
            options: dict[str, Any] = {
                **({'stop': stop} if stop else {}),
                **({'stream': True} if stream else {}),
                **({'tools': tools} if tools else {}),
                **({'jsonSchema': schema} if schema is not None else {}),
            }
            payload = {'role': self.role, 'messages': messages, 'options': options}
            if not stream:
                reply = await request('model', payload)
            else:
                # The runtime checks every delta before it reaches this queue, so a blocked delta
                # never gets here; the final reply is checked again before it is returned.
                chunks: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
                pending = asyncio.ensure_future(request('model', payload, on_model_chunk=chunks.put_nowait))
                pending.add_done_callback(lambda _: chunks.put_nowait(None))
                try:
                    while (chunk := await chunks.get()) is not None:
                        if run.failure is not None:
                            raise run.failure
                        if chunk['content']:
                            yield LlmResponse(
                                content=types.Content(role='model', parts=[types.Part(text=chunk['content'])]),
                                partial=True,
                            )
                    reply = await pending
                finally:
                    # Abandoning the stream cancels the bridge request and drains it.
                    if not pending.done():
                        pending.cancel()
                    await asyncio.wait([pending])
                    if not pending.cancelled():
                        pending.exception()
            if run.failure is not None:
                raise run.failure
            yield self._response(run, reply, offered)
        except Exception as error:
            # Any other failure is fatal too, so an author callback cannot swallow it.
            run.fail(error)
            raise

    @staticmethod
    def _response(run: _Run, reply: dict[str, Any], offered: set[str]) -> LlmResponse:
        calls = reply.get('toolCalls') or []
        if calls and not offered:
            raise GalaxieError('unsupported')
        parts: list[types.Part] = [types.Part(text=reply['content'])] if reply['content'] else []
        for call in calls:
            name = call['function']['name']
            if name not in offered:
                raise GalaxieError('invalid')
            try:
                arguments = json.loads(call['function']['arguments'])
            except ValueError:
                raise GalaxieError('invalid') from None
            if not isinstance(arguments, dict):
                raise GalaxieError('invalid')
            # Provider call IDs are discarded; the run assigns IDs after those already in the session.
            parts.append(types.Part(function_call=types.FunctionCall(
                id=run.take_call_id(), name=name, args=arguments,
            )))
        response = LlmResponse(
            content=types.Content(role='model', parts=parts or [types.Part(text='')]),
            turn_complete=True,
        )
        usage = reply.get('usage')
        if usage is not None:
            response.usage_metadata = types.GenerateContentResponseUsageMetadata(
                prompt_token_count=usage['input_tokens'], candidates_token_count=usage['output_tokens'],
                total_token_count=usage['total_tokens'],
            )
        return response

    def connect(self, llm_request: LlmRequest) -> Any:
        raise GalaxieError('unsupported')


def llm(role: str) -> BaseLlm:
    """The router-backed model for a declared role (ADR-0006)."""
    if not isinstance(role, str) or not role:
        raise GalaxieError('invalid')
    model = _GalaxieLlm(model=f'galaxie/{role}', role=role)
    _models.add(model)
    return model


def _scope(tool_context: ToolContext, run: _Run) -> str:
    """The write-replay scope: the branch, the branch-local index of the call's event and its part."""
    branch = tool_context.branch or ''
    ordinal = 0
    for event in tool_context.session.events:
        calls = [
            (part.function_call.id, position)
            for position, part in enumerate(event.content.parts or []) if part.function_call is not None
        ] if event.content is not None else []
        if not calls or (event.branch or '') != branch:
            continue
        for identifier, position in calls:
            if identifier == tool_context.function_call_id:
                return f'adk-python/{run.conversation}/{branch or "root"}/{ordinal}/{position}'
        ordinal += 1
    raise GalaxieError('invalid')


def _parameter_schema(parameters: Any) -> dict[str, Any]:
    if isinstance(parameters, type) and issubclass(parameters, BaseModel):
        return _json(parameters.model_json_schema())
    if _object(parameters):
        return _json(parameters)
    raise GalaxieError('invalid')


class _CapabilityTool(BaseTool):
    """A tool that calls a bound capability through the broker."""

    def __init__(self, name: str, capability: str, parameters: dict[str, Any], description: str) -> None:
        super().__init__(name=name, description=description)
        self._capability = capability
        self._parameters = parameters

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(
            name=self.name, description=self.description, parameters_json_schema=self._parameters,
        )

    async def run_async(self, *, args: dict[str, Any], tool_context: ToolContext) -> Any:
        run = _active.get()
        if run is None:
            raise GalaxieError('invalid')
        async with run.lock:
            if run.failure is not None:
                raise run.failure
            try:
                scope = _scope(tool_context, run)
            except GalaxieError as error:
                raise run.fail(error) from None
            try:
                result = await capabilities.call(self._capability, _json(args), effect_scope=scope)
            except GalaxieError as error:
                # A denial or a validation failure is the model's to see, as a fixed message.
                if error.code in _MODEL_VISIBLE:
                    return {'error': ERROR_MESSAGES[error.code]}
                raise run.fail(error) from None
        return _json(result)


def capability_tool(name: str, capability: str, parameters: Any, description: str) -> BaseTool:
    """A tool that calls the bound capability `capability` with JSON Schema or pydantic `parameters`."""
    tool_name = re.sub(r'[^A-Za-z0-9_]', '_', name) if isinstance(name, str) else ''
    if tool_name[:1].isdigit():
        tool_name = '_' + tool_name
    if (
        not _TOOL_NAME.match(tool_name[:64]) or not isinstance(capability, str) or not capability
        or not isinstance(description, str)
    ):
        raise GalaxieError('invalid')
    tool = _CapabilityTool(tool_name[:64], capability, _parameter_schema(parameters), description)
    _tools.add(tool)
    return tool


def loop_exit() -> BaseTool:
    """ADK's exit tool, which ends the enclosing LoopAgent; it is admitted only through this helper."""
    tool = FunctionTool(exit_loop)
    _tools.add(tool)
    return tool


def _is_exit(tool: Any) -> bool:
    return type(tool) is FunctionTool and tool.func is exit_loop and tool in _tools


def _validate(root: Any) -> None:
    """Fail closed unless every agent, model and tool in the tree is one galaxie can govern."""
    visited = 0

    def walk(agent: Any, inherited: bool, depth: int, path: set[int]) -> bool:
        nonlocal visited
        visited += 1
        if depth > MAX_DEPTH or visited > MAX_AGENTS or id(agent) in path:
            raise GalaxieError('unsupported')
        if type(agent) not in (LlmAgent, SequentialAgent, ParallelAgent, LoopAgent):
            raise GalaxieError('unsupported')
        fields = type(agent).model_fields
        if any(getattr(agent, name) != fields[name].default for name in _REFUSED_FIELDS if name in fields):
            raise GalaxieError('unsupported')
        known = inherited
        exits = False
        if isinstance(agent, LlmAgent):
            if agent.model != '':
                if type(agent.model) is not _GalaxieLlm or agent.model not in _models:
                    raise GalaxieError('unsupported')
                known = True
            # An agent with no model of its own and none above it would fall back to ADK's registry.
            if not known:
                raise GalaxieError('unsupported')
            if agent.code_executor is not None or agent.planner is not None:
                raise GalaxieError('unsupported')
            # A sub-agent is in chat mode by default; task delegation modes are not governed.
            if getattr(agent.mode, 'value', agent.mode) not in (None, 'chat'):
                raise GalaxieError('unsupported')
            if not isinstance(agent.tools, list):
                raise GalaxieError('invalid')
            for tool in agent.tools:
                if type(tool) is _CapabilityTool and tool in _tools:
                    continue
                if _is_exit(tool):
                    exits = True
                    continue
                raise GalaxieError('unsupported')
        if not isinstance(agent.sub_agents, list):
            raise GalaxieError('invalid')
        path.add(id(agent))
        for child in agent.sub_agents:
            exits = walk(child, known, depth + 1, path) or exits
        path.discard(id(agent))
        if isinstance(agent, LoopAgent) and agent.max_iterations is None and not exits:
            raise GalaxieError('unsupported')
        return exits

    walk(root, False, 0, set())


class GalaxieSessionService(InMemorySessionService):
    """In-memory sessions, with a mark a failed run returns to."""

    def mark(self, session_id: str) -> tuple[int, dict[str, Any]]:
        stored = self.sessions[APP_NAME][USER_ID][session_id]
        return len(stored.events), copy.deepcopy(stored.state)

    def rollback(self, session_id: str, mark: tuple[int, dict[str, Any]]) -> None:
        stored = self.sessions[APP_NAME][USER_ID][session_id]
        del stored.events[mark[0]:]
        stored.state.clear()
        stored.state.update(mark[1])


@contextlib.contextmanager
def quiet() -> Iterator[None]:
    """ADK's deprecation warnings and loggers write to the page console; they stay silent."""
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        yield


def _mute_loggers() -> None:
    for name in ('google_adk', 'google.adk', 'google_genai', 'google.genai'):
        logger = logging.getLogger(name)
        logger.handlers = [logging.NullHandler()]
        logger.propagate = False


_mute_loggers()


class _Deltas:
    """Bounded text deltas from growing text; a surrogate pair is never split.

    A provider can end one chunk on a high surrogate and start the next on its low half. The halves
    are joined here, and a trailing high surrogate waits for the next chunk.
    """

    def __init__(self) -> None:
        self._held = ''

    def feed(self, text: str) -> list[str]:
        text = (self._held + text).encode('utf-16-le', 'surrogatepass').decode('utf-16-le', 'surrogatepass')
        self._held = ''
        if text and '\ud800' <= text[-1] <= '\udbff':
            self._held, text = text[-1], text[:-1]
        return [text[start:start + MAX_DELTA] for start in range(0, len(text), MAX_DELTA)]

    def reset(self) -> None:
        self._held = ''


def _markers(event: Any, position: int) -> list[dict[str, Any]]:
    """Content-free step markers: the step, the offered tool's name and a run-wide position."""
    markers: list[dict[str, Any]] = []
    for part in event.content.parts or [] if event.content is not None else []:
        call, response = part.function_call, part.function_response
        step = 'tool_call' if call is not None else 'tool_result' if response is not None else ''
        name = call.name if call is not None else response.name if response is not None else None
        if step and isinstance(name, str):
            markers.append({'step': step, 'tool': name, 'index': position + len(markers)})
    return markers


class Executor:
    """Run an ADK agent tree with explicit input and output projections."""

    def __init__(self, agent: BaseAgent) -> None:
        with quiet():
            _validate(agent)
        self.agent = agent
        self._sessions = GalaxieSessionService()
        self._runners: dict[str, Runner] = {}

    def _runner(self, session: str) -> Runner:
        runner = self._runners.get(session)
        if runner is None:
            plugin = ToolCallIntegrityPlugin(secret_key=secrets.token_bytes(32))
            runner = Runner(
                app=App(name=APP_NAME, root_agent=self.agent, plugins=[plugin]),
                session_service=self._sessions,
            )
            self._runners[session] = runner
        return runner

    async def run(
        self, input: Any, session: str, steps: int, on_stream: Callable[[str, Any], None] | None = None,
    ) -> Any:
        if not isinstance(session, str) or not session or type(steps) is not int or steps < 1:
            raise GalaxieError('invalid')
        if (
            not isinstance(input, dict) or set(input) != {'prompt'}
            or not isinstance(input['prompt'], str) or not input['prompt']
        ):
            raise GalaxieError('invalid')
        if session not in self._sessions.sessions.get(APP_NAME, {}).get(USER_ID, {}):
            await self._sessions.create_session(app_name=APP_NAME, user_id=USER_ID, session_id=session)
        stored = self._sessions.sessions[APP_NAME][USER_ID][session]
        mark = self._sessions.mark(session)
        run = _Run(steps, session, sum(
            1 for event in stored.events if event.content is not None
            for part in event.content.parts or [] if part.function_call is not None
        ))
        token = _active.set(run)
        generator: Any = None
        thrown: BaseException | None = None
        cancelled = False
        last: tuple[str | None, str, Any] | None = None
        deltas: dict[str, _Deltas] = {}
        position = 0
        try:
            with quiet():
                generator = self._runner(session).run_async(
                    user_id=USER_ID, session_id=session,
                    new_message=types.Content(role='user', parts=[types.Part(text=input['prompt'])]),
                    # A backstop only: the model call count in the run enforces the step budget.
                    run_config=RunConfig(
                        max_llm_calls=steps + 1,
                        streaming_mode=StreamingMode.SSE if on_stream is not None else StreamingMode.NONE,
                    ),
                )
                async for event in generator:
                    if event.error_code is not None and run.failure is None:
                        run.fail(None)
                    if run.failure is not None:
                        break
                    if event.partial:
                        # The text was checked in the runtime before this model saw it.
                        if on_stream is not None and event.content is not None:
                            text = ''.join(
                                part.text or '' for part in event.content.parts or []
                                if part.thought is not True and part.function_call is None
                            )
                            # Parallel agents interleave, so each author holds its own half-pair.
                            for delta in deltas.setdefault(event.author, _Deltas()).feed(text):
                                on_stream('messages', {'author': event.author, 'text': delta})
                        continue
                    if event.author in deltas:
                        deltas[event.author].reset()
                    if on_stream is not None:
                        for marker in _markers(event, position):
                            on_stream('updates', marker)
                            position += 1
                    # A state-only final event (an after-agent callback) carries no answer.
                    if not event.is_final_response() or event.content is None:
                        continue
                    text = ''.join(
                        part.text or '' for part in event.content.parts or [] if part.thought is not True
                    )
                    last = (event.author, text, event.actions.state_delta if event.actions else None)
        except asyncio.CancelledError:
            cancelled = True
            raise
        except Exception as error:
            thrown = error
        finally:
            _active.reset(token)
            if generator is not None:
                with contextlib.suppress(Exception):
                    await generator.aclose()
            # ADK can end a cancelled run without raising, so the task's own cancel request counts too.
            task = asyncio.current_task()
            if task is not None and task.cancelling() > 0:
                cancelled = True
            if cancelled:
                self._sessions.rollback(session, mark)
        if cancelled:
            raise asyncio.CancelledError()
        fatal = run.failure or _galaxie_error(thrown)
        if fatal is None and thrown is not None:
            fatal = GalaxieError('executor_error')
        if fatal is None and last is None:
            fatal = GalaxieError('executor_error')
        if fatal is not None:
            self._sessions.rollback(session, mark)
            raise fatal
        assert last is not None
        return _json(self._output(last))

    def _output(self, last: tuple[str | None, str, Any]) -> Any:
        author, text, delta = last
        agent = self.agent.find_agent(author) if author else None
        key = agent.output_key if isinstance(agent, LlmAgent) else None
        if key and isinstance(delta, dict) and key in delta:
            return delta[key]
        return text


def prepare_executor(value: Any) -> Executor:
    """Accept the entry factory's agent tree or an explicit executor wrapper."""
    if isinstance(value, Executor):
        return value
    if isinstance(value, BaseAgent):
        return Executor(value)
    raise GalaxieError('unsupported')
