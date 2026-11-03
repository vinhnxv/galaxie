# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""Google ADK agents, models and capability tools backed by the JavaScript runtime."""

import asyncio
import contextlib
import copy
import hashlib
import json
import logging
import math
import re
import secrets
import warnings
import weakref
from collections.abc import AsyncGenerator, Callable, Iterator
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, cast

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
# The call ADK issues to ask the user about a confirmation-gated tool call.
_CONFIRMATION = 'adk_request_confirmation'


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
            kinds = {
                name: 'confirmation' if getattr(tool, '_confirm', False) else 'long-running' if tool.is_long_running else ''
                for name, tool in llm_request.tools_dict.items()
            }
            yield self._response(run, reply, offered, kinds)
        except Exception as error:
            # Any other failure is fatal too, so an author callback cannot swallow it.
            run.fail(error)
            raise

    @staticmethod
    def _response(run: _Run, reply: dict[str, Any], offered: set[str], kinds: dict[str, str]) -> LlmResponse:
        calls = reply.get('toolCalls') or []
        if calls and not offered:
            raise GalaxieError('unsupported')
        # ADK cannot resume a confirmation beside a long-running call, and the long-running capability
        # would already have run by the time the tracker saw the turn, so the turn is refused first.
        if {kinds.get(call['function']['name'], '') for call in calls} >= {'confirmation', 'long-running'}:
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

    def __init__(
        self, name: str, capability: str, parameters: dict[str, Any], description: str,
        confirm: bool = False, long_running: bool = False,
    ) -> None:
        super().__init__(name=name, description=description, is_long_running=long_running)
        self._capability = capability
        self._parameters = parameters
        self._confirm = confirm

    @property
    def pauses(self) -> bool:
        """True when a call can end the run to wait for the user."""
        return self._confirm or self.is_long_running

    async def check_require_confirmation(self, args: dict[str, Any], tool_context: ToolContext) -> bool:
        return self._confirm

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


def capability_tool(
    name: str, capability: str, parameters: Any, description: str, *,
    require_confirmation: bool = False, long_running: bool = False,
) -> BaseTool:
    """A tool that calls the bound capability `capability` with JSON Schema or pydantic `parameters`.

    `require_confirmation` asks the user before each call; `long_running` makes the call's result
    the pending answer and ends the run until the user supplies the real one (ADR-0022).
    """
    tool_name = re.sub(r'[^A-Za-z0-9_]', '_', name) if isinstance(name, str) else ''
    if tool_name[:1].isdigit():
        tool_name = '_' + tool_name
    if (
        not _TOOL_NAME.match(tool_name[:64]) or not isinstance(capability, str) or not capability
        or not isinstance(description, str) or type(require_confirmation) is not bool
        or type(long_running) is not bool or (require_confirmation and long_running)
    ):
        raise GalaxieError('invalid')
    tool = _CapabilityTool(
        tool_name[:64], capability, _parameter_schema(parameters), description,
        require_confirmation, long_running,
    )
    _tools.add(tool)
    return tool


def loop_exit() -> BaseTool:
    """ADK's exit tool, which ends the enclosing LoopAgent; it is admitted only through this helper."""
    tool = FunctionTool(exit_loop)
    _tools.add(tool)
    return tool


def _is_exit(tool: Any) -> bool:
    return type(tool) is FunctionTool and tool.func is exit_loop and tool in _tools


def _validate(root: Any) -> frozenset[str]:
    """Fail closed unless every agent, model and tool in the tree is one galaxie can govern.

    Returns the names of the agents that can pause. ADK resumes only the agent that paused, so a
    pausing agent must be the last one to run: native ADK 2.12.0 never runs the siblings after it,
    and a pause inside a loop or parallel agent resumes without the surrounding iteration (ADR-0022).
    """
    visited = 0
    names: dict[str, int] = {}
    pausing: set[str] = set()

    def walk(agent: Any, inherited: bool, depth: int, path: set[int], lineage: tuple[tuple[Any, int], ...]) -> bool:
        nonlocal visited
        visited += 1
        if depth > MAX_DEPTH or visited > MAX_AGENTS or id(agent) in path:
            raise GalaxieError('unsupported')
        if type(agent) not in (LlmAgent, SequentialAgent, ParallelAgent, LoopAgent):
            raise GalaxieError('unsupported')
        fields = type(agent).model_fields
        if any(getattr(agent, name) != fields[name].default for name in _REFUSED_FIELDS if name in fields):
            raise GalaxieError('unsupported')
        names[agent.name] = names.get(agent.name, 0) + 1
        known = inherited
        exits = False
        pauses = False
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
                    pauses = pauses or cast(_CapabilityTool, tool).pauses
                    continue
                if _is_exit(tool):
                    exits = True
                    continue
                raise GalaxieError('unsupported')
        if not isinstance(agent.sub_agents, list):
            raise GalaxieError('invalid')
        if pauses:
            if agent.sub_agents or any(
                type(parent) is not SequentialAgent or index != len(parent.sub_agents) - 1
                for parent, index in lineage
            ):
                raise GalaxieError('unsupported')
            pausing.add(agent.name)
        path.add(id(agent))
        for index, child in enumerate(agent.sub_agents):
            exits = walk(child, known, depth + 1, path, (*lineage, (agent, index))) or exits
        path.discard(id(agent))
        if isinstance(agent, LoopAgent) and agent.max_iterations is None and not exits:
            raise GalaxieError('unsupported')
        return exits

    walk(root, False, 0, set(), ())
    # The agent named on a pausing event must identify one agent.
    if any(names[name] != 1 for name in pausing):
        raise GalaxieError('unsupported')
    return frozenset(pausing)


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
        # ADK's own confirmation call is not an offered tool; the pause has its own marker.
        if step and isinstance(name, str) and name != _CONFIRMATION:
            markers.append({'step': step, 'tool': name, 'index': position + len(markers)})
    return markers


def _interaction(value: Any) -> dict[str, Any]:
    """Mirror the four-field JSON display contract without importing a framework."""
    def json_value(item: Any, ancestors: set[int]) -> bool:
        if item is None or type(item) in (str, bool, int):
            return True
        if type(item) is float:
            return math.isfinite(item)
        if type(item) not in (list, dict) or id(item) in ancestors:
            return False
        ancestors = ancestors | {id(item)}
        return all(json_value(child, ancestors) for child in item) if type(item) is list else all(
            type(key) is str and json_value(child, ancestors) for key, child in item.items()
        )

    if (
        type(value) is not dict or set(value) != {'surfaceId', 'viewRevision', 'component', 'props'}
        or any(type(value[key]) is not str or not value[key] for key in ('surfaceId', 'viewRevision', 'component'))
        or re.fullmatch(r'[A-Za-z][\w-]*\.[A-Za-z][\w-]*/v\d+', value['component'], re.ASCII) is None
        or type(value['props']) is not dict or not json_value(value, set())
    ):
        raise GalaxieError('unsupported')
    return _json(value)


@dataclass(frozen=True)
class _Ask:
    """One call the run waits on: where the answer goes and what the author's hooks may see."""

    kind: str
    call: str
    name: str
    tool: str
    args: dict[str, Any]

    def request(self) -> dict[str, Any]:
        return {'kind': self.kind, 'tool': self.tool, 'args': copy.deepcopy(self.args)}


@dataclass
class _Pending:
    asks: list[_Ask]
    interaction: dict[str, Any]


def _confirmation(call: types.FunctionCall) -> _Ask:
    original = (call.args or {}).get('originalFunctionCall')
    if (
        not isinstance(call.id, str) or not call.id or not isinstance(original, dict)
        or not isinstance(original.get('name'), str) or not isinstance(original.get('args') or {}, dict)
    ):
        raise GalaxieError('unsupported')
    return _Ask('confirmation', call.id, _CONFIRMATION, original['name'], _json(original.get('args') or {}))


class _Tracker:
    """Watches the events of one run for the point where ADK needs the user (KTD10).

    A confirmation request ends the invocation by itself. A long-running tool pauses it only after
    the tool has returned its pending result, before ADK asks the model about it.
    """

    def __init__(self, pausing: frozenset[str]) -> None:
        self.asks: list[_Ask] | None = None
        self._pausing = pausing
        self._flagged: list[_Ask] = []

    def observe(self, event: Any) -> bool:
        """True when this event is the one the run stops on.

        Raises `unsupported` for a turn ADK cannot resume faithfully: a confirmation beside a
        long-running call (ADK drops the long-running answer), or a pause from an agent that is not
        a validated pausing agent.
        """
        parts = event.content.parts or [] if event.content is not None else []
        calls = [part.function_call for part in parts if part.function_call is not None]
        gates = [call for call in calls if call.name == _CONFIRMATION]
        if gates:
            if self._flagged or self.asks is not None or event.author not in self._pausing:
                raise GalaxieError('unsupported')
            self.asks = [_confirmation(call) for call in gates]
            return False
        if calls:
            flagged = set(event.long_running_tool_ids or ())
            self._flagged = [
                _Ask('long-running', call.id, call.name, call.name, _json(call.args or {}))
                for call in calls if isinstance(call.id, str) and call.id in flagged
            ]
            return False
        if self.asks is not None or not self._flagged:
            return False
        # The next event carries the turn's (possibly empty) tool results; ADK would call the model
        # about them next, so the run stops here instead.
        if event.actions.requested_tool_confirmations or event.author not in self._pausing:
            raise GalaxieError('unsupported')
        self.asks = self._flagged
        return True

    def ended(self) -> None:
        """The run ended by itself: long-running calls with no result event are the pause."""
        if self.asks is None and self._flagged:
            self.asks = self._flagged


def _default_resume(requests: list[dict[str, Any]], action: str, payload: Any) -> list[dict[str, Any]]:
    """Approve or deny every confirmation, nothing else."""
    indexes = payload.get('indexes') if type(payload) is dict else None
    if (
        action not in ('approve', 'deny') or any(request['kind'] != 'confirmation' for request in requests)
        or type(payload) is not dict or set(payload) != {'indexes'} or type(indexes) is not list
        or any(type(index) is not int for index in indexes)
        or sorted(indexes) != list(range(len(requests)))
    ):
        raise GalaxieError('invalid')
    return [{'confirmed': action == 'approve'} for _ in requests]


def _answer(asks: list[_Ask], decisions: Any) -> types.Content:
    """The user message that answers every ask, from checked decisions."""
    if type(decisions) is not list or len(decisions) != len(asks):
        raise GalaxieError('invalid')
    parts: list[types.Part] = []
    for ask, decision in zip(asks, decisions):
        if type(decision) is not dict or len(decision) != 1:
            raise GalaxieError('invalid')
        if ask.kind == 'confirmation':
            if type(decision.get('confirmed')) is not bool:
                raise GalaxieError('invalid')
            response = {'confirmed': decision['confirmed']}
        else:
            if type(decision.get('response')) is not dict:
                raise GalaxieError('invalid')
            response = _json(decision['response'])
        parts.append(types.Part(function_response=types.FunctionResponse(id=ask.call, name=ask.name, response=response)))
    return types.Content(role='user', parts=parts)


class Executor:
    """Run an ADK agent tree with explicit input and output projections."""

    def __init__(
        self, agent: BaseAgent, *,
        interaction: Callable[[list[dict[str, Any]]], dict[str, Any]] | None = None,
        resume: Callable[[list[dict[str, Any]], str, Any], list[dict[str, Any]]] | None = None,
    ) -> None:
        with quiet():
            self._pausing = _validate(agent)
        # A pause with nowhere to show it would run its capability and then fail, so refuse it first.
        if self._pausing and interaction is None:
            raise GalaxieError('unsupported')
        self.agent = agent
        self.interaction = interaction
        self.resume = resume
        self._sessions = GalaxieSessionService()
        self._runners: dict[str, Runner] = {}
        self._pauses: dict[str, int] = {}
        self._pending: dict[str, _Pending] = {}

    def pending(self, session: str) -> dict[str, Any] | None:
        """The one pending interaction of a session."""
        pause = self._pending.get(session)
        return copy.deepcopy(pause.interaction) if pause is not None else None

    def _answers(self, pause: _Pending, action: str, payload: Any) -> types.Content:
        requests = [ask.request() for ask in pause.asks]
        try:
            decisions = self.resume(requests, action, payload) if self.resume is not None else _default_resume(requests, action, payload)
            return _answer(pause.asks, decisions)
        except Exception:
            raise GalaxieError('invalid') from None

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
        resume: dict[str, Any] | None = None,
    ) -> Any:
        if not isinstance(session, str) or not session or type(steps) is not int or steps < 1:
            raise GalaxieError('invalid')
        pause = self._pending.get(session)
        if resume is not None:
            # Every check precedes the run, so a stale or unmatched answer runs no tool.
            if type(resume) is not dict:
                raise GalaxieError('invalid')
            if pause is None or resume.get('interactionId') != pause.interaction['id']:
                raise GalaxieError('stale')
            if set(resume) != {'interactionId', 'action', 'payload'} or not isinstance(resume['action'], str):
                raise GalaxieError('invalid')
            message = self._answers(pause, resume['action'], resume['payload'])
        else:
            if (
                not isinstance(input, dict) or set(input) != {'prompt'}
                or not isinstance(input['prompt'], str) or not input['prompt']
            ):
                raise GalaxieError('invalid')
            # A new prompt would leave the paused calls unanswered in the history.
            if pause is not None:
                raise GalaxieError('invalid')
            message = types.Content(role='user', parts=[types.Part(text=input['prompt'])])
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
        tracker = _Tracker(self._pausing)
        try:
            with quiet():
                generator = self._runner(session).run_async(
                    user_id=USER_ID, session_id=session,
                    new_message=message,
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
                    if tracker.observe(event):
                        break
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
        tracker.ended()
        value: dict[str, Any] | None = None
        if fatal is None and tracker.asks is not None:
            try:
                if self.interaction is None:
                    raise GalaxieError('unsupported')
                value = _interaction(self.interaction([ask.request() for ask in tracker.asks]))
            except Exception:
                fatal = GalaxieError('unsupported')
        if fatal is None and last is None and tracker.asks is None:
            fatal = GalaxieError('executor_error')
        if fatal is not None:
            self._sessions.rollback(session, mark)
            raise fatal
        if tracker.asks is not None and value is not None:
            if on_stream is not None:
                try:
                    for index, ask in enumerate(tracker.asks):
                        on_stream('updates', {'step': 'paused', 'tool': ask.tool, 'index': position + index})
                except Exception as error:
                    # Nothing was published, so the session returns to where this run found it.
                    self._sessions.rollback(session, mark)
                    raise (_galaxie_error(error) or GalaxieError('executor_error')) from None
            self._pending.pop(session, None)
            ordinal = self._pauses.get(session, 0)
            self._pauses[session] = ordinal + 1
            identifier = hashlib.sha256(json.dumps([session, ordinal]).encode()).hexdigest()
            self._pending[session] = _Pending(tracker.asks, {'id': identifier, 'value': value})
            return None
        self._pending.pop(session, None)
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
