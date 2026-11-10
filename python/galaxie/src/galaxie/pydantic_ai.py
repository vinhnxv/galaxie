# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""pydantic-ai models and capability tools backed by the JavaScript runtime."""

import asyncio
import hashlib
import json
import math
import re
from copy import deepcopy
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from pydantic_ai import Agent, AgentRunResult, Conversation, ConversationTypeAdapter, DeferredToolRequests, DeferredToolResults, NativeOutput, RunContext, Tool, capture_run_messages
from pydantic_ai.capabilities import Instrumentation
from pydantic_ai.exceptions import UnexpectedModelBehavior, UsageLimitExceeded
from pydantic_ai.messages import (
    ModelMessage, ModelRequest, ModelResponse, ModelResponsePart, ModelResponseStreamEvent,
    PartStartEvent, PartDeltaEvent, RetryPromptPart, SystemPromptPart, TextPart, TextPartDelta,
    ToolCallPart, ToolReturnPart, UserPromptPart,
)
from pydantic_ai.models import Model, ModelRequestParameters, StreamedResponse
from pydantic_ai.models.instrumented import InstrumentedModel
from pydantic_ai.settings import ModelSettings
from pydantic_ai.toolsets import FunctionToolset
from pydantic_ai.usage import RequestUsage, UsageLimits
from pydantic_core import to_jsonable_python

from . import capabilities
from ._bridge import GalaxieError, request

_positions: ContextVar[int] = ContextVar('galaxie_pydantic_positions', default=0)


def _json(value: Any) -> Any:
    try:
        return json.loads(json.dumps(to_jsonable_python(value), allow_nan=False, ensure_ascii=False))
    except (ValueError, TypeError, OverflowError):
        raise GalaxieError('unsupported') from None


def _call(part: ToolCallPart) -> dict[str, Any]:
    return {
        'id': part.tool_call_id, 'type': 'function',
        'function': {'name': part.tool_name, 'arguments': part.args_as_json_str()},
    }


def _json_number(value: str) -> float:
    return float(value) + 0.0


def _messages(messages: list[ModelMessage], parameters: ModelRequestParameters) -> list[dict[str, Any]]:
    converted = []
    for message in messages:
        if isinstance(message, ModelRequest):
            for part in message.parts:
                if isinstance(part, SystemPromptPart):
                    converted.append({'role': 'system', 'content': part.content})
                elif isinstance(part, UserPromptPart):
                    if not isinstance(part.content, str):
                        raise GalaxieError('unsupported')
                    converted.append({'role': 'user', 'content': part.content})
                elif isinstance(part, ToolReturnPart):
                    text, files = part.model_response_str_and_user_content()
                    if files:
                        raise GalaxieError('unsupported')
                    converted.append({'role': 'tool', 'content': text, 'tool_call_id': part.tool_call_id})
                elif isinstance(part, RetryPromptPart):
                    converted.append({
                        'role': 'tool' if part.tool_name else 'user', 'content': part.model_response(),
                        **({'tool_call_id': part.tool_call_id} if part.tool_name else {}),
                    })
                else:
                    raise GalaxieError('unsupported')
        elif isinstance(message, ModelResponse):
            texts = []
            calls = []
            for part in message.parts:
                if isinstance(part, TextPart):
                    texts.append(part.content)
                elif isinstance(part, ToolCallPart):
                    calls.append(_call(part))
                else:
                    raise GalaxieError('unsupported')
            if texts or calls:
                converted.append({
                    'role': 'assistant', 'content': '\n\n'.join(texts),
                    **({'toolCalls': calls} if calls else {}),
                })
        else:
            raise GalaxieError('unsupported')
    leading = 0
    while leading < len(converted) and converted[leading]['role'] == 'system':
        leading += 1
    converted[leading:leading] = [
        {'role': 'system', 'content': part.content} for part in parameters.instruction_parts or []
    ]
    return converted


def _reply(value: Any, messages: list[ModelMessage], offered: set[str], role: str) -> ModelResponse:
    if (
        not isinstance(value, dict) or not set(value) <= {'content', 'toolCalls', 'usage'}
        or not isinstance(value.get('content'), str)
    ):
        raise GalaxieError('invalid')
    usage = value.get('usage')
    if usage is not None and (
        not isinstance(usage, dict) or set(usage) != {'input_tokens', 'output_tokens', 'total_tokens'}
        or any(type(count) is not int or count < 0 for count in usage.values())
        or usage['input_tokens'] + usage['output_tokens'] != usage['total_tokens']
    ):
        raise GalaxieError('invalid')
    calls = value.get('toolCalls', [])
    if not isinstance(calls, list):
        raise GalaxieError('invalid')
    seen = {
        part.tool_call_id for message in messages if isinstance(message, ModelResponse)
        for part in message.parts if isinstance(part, ToolCallPart)
    }
    parts: list[ModelResponsePart] = [TextPart(value['content'])] if value['content'] or not calls else []
    for call in calls:
        if (
            not isinstance(call, dict) or set(call) != {'id', 'type', 'function'}
            or call['type'] != 'function' or not isinstance(call['id'], str)
            or not 0 < len(call['id']) <= 128 or call['id'] in seen
            or not isinstance(call['function'], dict) or set(call['function']) != {'name', 'arguments'}
            or not isinstance(call['function']['name'], str) or call['function']['name'] not in offered
            or not isinstance(call['function']['arguments'], str)
        ):
            raise GalaxieError('invalid')
        seen.add(call['id'])
        parts.append(ToolCallPart(call['function']['name'], call['function']['arguments'], tool_call_id=call['id']))
    return ModelResponse(
        parts=parts, model_name=role,
        usage=RequestUsage(input_tokens=usage['input_tokens'], output_tokens=usage['output_tokens']) if usage else RequestUsage(),
    )


class GalaxieModel(Model):
    """Route every model request through JavaScript before exposing its reply."""

    def __init__(self, role: str) -> None:
        if not isinstance(role, str) or not role:
            raise GalaxieError('invalid')
        super().__init__(profile={
            'supports_tools': True, 'supports_text_output': True,
            'supports_json_schema_output': True, 'supports_json_object_output': False,
            'supports_image_output': False, 'default_structured_output_mode': 'tool',
        })
        self.role = role

    @property
    def model_name(self) -> str:
        return self.role

    @property
    def system(self) -> str:
        return 'galaxie'

    def _prepare(
        self, messages: list[ModelMessage], model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> tuple[dict[str, Any], ModelRequestParameters]:
        if (
            model_request_parameters.native_tools or model_request_parameters.thinking
            or model_request_parameters.allow_image_output
            or (model_settings and not set(model_settings) <= {'stop_sequences'})
            or (self.settings and not set(self.settings) <= {'stop_sequences'})
        ):
            raise GalaxieError('unsupported')
        settings, parameters = self.prepare_request(model_settings, model_request_parameters)
        tools = [
            {'type': 'function', 'function': {
                'name': tool.name, 'description': tool.description or '',
                'parameters': tool.parameters_json_schema,
                **({'strict': True} if tool.strict else {}),
            }} for tool in parameters.declared_tool_defs.values()
        ]
        options = {}
        if parameters.output_mode == 'native':
            if parameters.declared_tool_defs or parameters.prompted_output_template or parameters.output_object is None:
                raise GalaxieError('unsupported')
            options['jsonSchema'] = _json(parameters.output_object.json_schema)
            # Native mode has no tools or resumed history: each earlier response failed validation.
            repairs = sum(isinstance(message, ModelResponse) for message in messages)
            if repairs:
                options['repairAttempt'] = repairs
        stop = settings.get('stop_sequences') if settings else None
        if stop is not None:
            options['stop'] = stop
        if tools:
            options['tools'] = tools
            options['toolChoice'] = 'auto' if parameters.allow_text_output else 'required'
        return {'role': self.role, 'messages': _messages(messages, parameters), 'options': options}, parameters

    async def request(
        self, messages: list[ModelMessage], model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> ModelResponse:
        payload, parameters = self._prepare(messages, model_settings, model_request_parameters)
        reply = await request('model', payload)
        return _reply(reply, messages, set(parameters.declared_tool_defs), self.role)

    @asynccontextmanager
    async def request_stream(
        self, messages: list[ModelMessage], model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters, run_context: RunContext[Any] | None = None,
    ) -> AsyncIterator[StreamedResponse]:
        payload, parameters = self._prepare(messages, model_settings, model_request_parameters)
        payload['options']['stream'] = True
        chunks: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        task = asyncio.create_task(request('model', payload, on_model_chunk=chunks.put_nowait))
        task.add_done_callback(lambda _: chunks.put_nowait(None))
        response = _GalaxieStream(parameters, self.role, messages, chunks, task)
        try:
            yield response
        finally:
            await response.close_stream()


class _GalaxieStream(StreamedResponse):
    def __init__(
        self, parameters: ModelRequestParameters, role: str, messages: list[ModelMessage],
        chunks: asyncio.Queue[dict[str, Any] | None], task: asyncio.Task[Any],
    ) -> None:
        super().__init__(model_request_parameters=parameters)
        self._role = role
        self._messages = messages
        self._chunks = chunks
        self._task = task
        self._timestamp = datetime.now(timezone.utc)

    async def _get_event_iterator(self) -> AsyncIterator[ModelResponseStreamEvent]:
        content: list[str] = []
        calls: dict[int, dict[str, list[str]]] = {}
        while (chunk := await self._chunks.get()) is not None:
            delta = chunk['content']
            content.append(delta)
            if delta:
                for event in self._parts_manager.handle_text_delta(vendor_part_id='text', content=delta):
                    yield event
            for fragment in chunk.get('toolCalls', []):
                index = fragment['index']
                if index not in calls:
                    calls[index] = {'id': [], 'name': [], 'arguments': []}
                call = calls[index]
                call['id'].append(fragment.get('id', ''))
                for key in ('name', 'arguments'):
                    call[key].append(fragment['function'].get(key, ''))
        value = await self._task
        reply = _reply(value, self._messages, set(self.model_request_parameters.declared_tool_defs), self._role)
        joined = [{
            'id': ''.join(calls[index]['id']),
            'function': {key: ''.join(calls[index][key]) for key in ('name', 'arguments')},
        } for index in calls]
        by_id = {call['id']: call for call in joined}
        final_calls = value.get('toolCalls', [])
        if ''.join(content) != value['content'] or len(joined) != len(final_calls) or len(by_id) != len(joined):
            raise GalaxieError('invalid')
        for final in final_calls:
            streamed = by_id.get(final['id'])
            # The JavaScript provider normalizes JSON arguments in its final reply.
            if streamed is None or streamed['function']['name'] != final['function']['name']:
                raise GalaxieError('invalid')
            arguments = [item['function']['arguments'] for item in (streamed, final)]
            try:
                arguments = [json.dumps(
                    json.loads(item, parse_int=_json_number, parse_float=_json_number),
                    sort_keys=True, allow_nan=False,
                ) for item in arguments]
            except ValueError:
                pass
            if arguments[0] != arguments[1]:
                raise GalaxieError('invalid')
        self._usage = reply.usage
        for index, part in enumerate(reply.parts):
            if isinstance(part, ToolCallPart):
                yield self._parts_manager.handle_tool_call_part(
                    vendor_part_id=index, tool_name=part.tool_name,
                    args=part.args_as_json_str(), tool_call_id=part.tool_call_id,
                )

    async def close_stream(self) -> None:
        if not self._task.done():
            self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)

    @property
    def model_name(self) -> str:
        return self._role

    @property
    def provider_name(self) -> None:
        return None

    @property
    def provider_url(self) -> None:
        return None

    @property
    def timestamp(self) -> datetime:
        return self._timestamp


def capability_tool(
    name: str, capability: str, parameters: dict[str, Any], description: str | None = None,
) -> Tool:
    """Create an async tool with the broker's capability name and JSON schema."""
    if not isinstance(name, str) or not name or not isinstance(capability, str) or not capability:
        raise GalaxieError('invalid')

    async def invoke(ctx: RunContext, **arguments: Any) -> Any:
        conversation = ctx.conversation_id
        if not isinstance(conversation, str) or not conversation:
            raise GalaxieError('invalid')
        for response_index, message in reversed(list(enumerate(ctx.messages))):
            if isinstance(message, ModelResponse):
                for part_index, part in enumerate(message.parts):
                    if isinstance(part, ToolCallPart) and part.tool_call_id == ctx.tool_call_id and part.tool_name == ctx.tool_name:
                        scope = f'pydantic-ai/{conversation}/{_positions.get() + response_index}/{part_index}'
                        return await capabilities.call(capability, arguments, effect_scope=scope, tool=True)
        raise GalaxieError('invalid')

    return Tool.from_schema(invoke, name=name, description=description, json_schema=parameters, takes_ctx=True)


def _uninstrumented(agent: Agent) -> None:
    def instrumented(capability: Any) -> bool:
        return isinstance(capability, Instrumentation) or any(
            instrumented(child) for child in getattr(capability, 'capabilities', [])
        )
    if (
        agent.instrument or isinstance(agent.model, InstrumentedModel)
        or instrumented(agent._root_capability)
    ):
        raise GalaxieError('unsupported')


def _validate_agent(agent: Agent) -> None:
    settings = agent.model_settings
    if callable(settings) or (settings and not set(settings) <= {'stop_sequences'}):
        raise GalaxieError('unsupported')
    spec = agent.output_type
    outputs = spec if isinstance(spec, Sequence) and not isinstance(spec, str) else [spec]
    for output in outputs:
        if isinstance(output, NativeOutput) and (
            DeferredToolRequests in outputs or isinstance(output.template, str)
            or any(not isinstance(toolset, FunctionToolset) or toolset.tools for toolset in agent.toolsets)
        ):
            raise GalaxieError('unsupported')


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


@dataclass
class _Pause:
    position: int
    messages: list[ModelMessage]
    requests: DeferredToolRequests
    interaction: dict[str, Any]


@dataclass
class _Conversation:
    position: int = 0
    pauses: int = 0
    pending: _Pause | None = None
    conversation: Conversation | None = None


class Executor:
    """Run an agent with explicit input and output projections."""

    def __init__(
        self, agent: Agent[Any, Any], *, prompt: Callable[[Any], str] | None = None,
        output: Callable[[Any], Any] | None = None,
        interaction: Callable[[DeferredToolRequests], dict[str, Any]] | None = None,
        resume: Callable[[DeferredToolRequests, str, Any], DeferredToolResults] | None = None,
    ) -> None:
        if not isinstance(agent, Agent):
            raise GalaxieError('unsupported')
        _uninstrumented(agent)
        _validate_agent(agent)
        self.agent = agent
        self.prompt = prompt
        self.output = output
        self.interaction = interaction
        self.resume = resume
        self._conversations: dict[str, _Conversation] = {}
        agent.instrument = False

    def pending(self, conversation_id: str) -> dict[str, Any] | None:
        """Read the one pending interaction, including a restored conversation."""
        state = self._conversations.get(conversation_id)
        return _json(state.pending.interaction) if state and state.pending else None

    def _snapshot(self, conversation_id: str, session: str | None = None) -> tuple[bytes, bytes]:
        state = self._conversations[conversation_id]
        if state.conversation is None:
            raise GalaxieError('unrecoverable')
        pause = state.pending
        try:
            return ConversationTypeAdapter.dump_json(state.conversation), json.dumps({
                'v': 1, 'position': state.position, 'pauses': state.pauses,
                'pending': {'position': pause.position, 'interaction': pause.interaction} if pause else None,
                **({'session': session} if session is not None else {}),
            }, allow_nan=False, ensure_ascii=False).encode()
        except Exception:
            raise GalaxieError('unsupported') from None

    def _restore(self, checkpoint: bytes, metadata: bytes, session: str | None = None) -> str:
        """Restore untrusted snapshot bytes; a bound session must match the stored one."""
        try:
            raw = json.loads(checkpoint)
            if type(raw) is not dict or set(raw) != {'messages', 'usage', 'conversation_id', 'deferred_tool_requests'}:
                raise ValueError()
            conversation = ConversationTypeAdapter.validate_json(checkpoint)
            identifier = conversation.conversation_id
            meta = json.loads(metadata)
            if (
                not isinstance(identifier, str) or not identifier
                or type(meta) is not dict
                or set(meta) != {'v', 'position', 'pauses', 'pending', *(('session',) if session is not None else ())}
                or (session is not None and meta['session'] != session)
                or type(meta['v']) is not int or meta['v'] != 1
                or any(type(meta[key]) is not int or meta[key] < 0 for key in ('position', 'pauses'))
            ):
                raise ValueError()
            state = _Conversation(position=meta['position'], pauses=meta['pauses'], conversation=conversation)
            pause = meta['pending']
            requests = conversation.deferred_tool_requests
            if pause is None:
                if requests is not None:
                    raise ValueError()
            else:
                if (
                    type(pause) is not dict or set(pause) != {'position', 'interaction'}
                    or type(pause['position']) is not int or pause['position'] < 0
                    or pause['position'] + len(conversation.messages) != state.position
                    or state.pauses < 1 or requests is None or not (requests.calls or requests.approvals)
                    or type(pause['interaction']) is not dict or set(pause['interaction']) != {'id', 'value'}
                    or pause['interaction']['id'] != hashlib.sha256(json.dumps([identifier, state.pauses - 1]).encode()).hexdigest()
                ):
                    raise ValueError()
                value = _interaction(pause['interaction']['value'])
                # Stored props must be what this agent's interaction factory derives from the requests.
                if self.interaction is None or _interaction(self.interaction(requests)) != value:
                    raise ValueError()
                calls = requests.calls + requests.approvals
                ids = [call.tool_call_id for call in calls]
                if (
                    len(set(ids)) != len(ids) or any(not 0 < len(call_id) <= 128 for call_id in ids)
                    or not set(requests.metadata) <= set(ids)
                ):
                    raise ValueError()
                responses = [message for message in conversation.messages if isinstance(message, ModelResponse)]
                if not responses:
                    raise ValueError()
                parts = [part for part in responses[-1].parts if isinstance(part, ToolCallPart)]
                if any(call not in parts for call in calls):
                    raise ValueError()
                state.pending = _Pause(pause['position'], conversation.messages, requests, pause['interaction'])
            self._conversations[identifier] = state
            return identifier
        except Exception:
            raise GalaxieError('unrecoverable') from None

    def _results(self, requests: DeferredToolRequests, action: str, payload: Any) -> DeferredToolResults:
        approvals = {call.tool_call_id for call in requests.approvals}
        calls = {call.tool_call_id for call in requests.calls}
        try:
            if self.resume is not None:
                results = self.resume(requests, action, payload)
            else:
                if (
                    action not in ('approve', 'deny') or calls
                    or type(payload) is not dict or set(payload) != {'toolCallIds'}
                    or type(payload['toolCallIds']) is not list
                    or any(type(identifier) is not str for identifier in payload['toolCallIds'])
                    or len(payload['toolCallIds']) != len(approvals)
                    or set(payload['toolCallIds']) != approvals
                ):
                    raise GalaxieError('invalid')
                results = DeferredToolResults(approvals={identifier: action == 'approve' for identifier in approvals})
            if (
                not isinstance(results, DeferredToolResults)
                or set(results.approvals) != approvals or set(results.calls) != calls
                or not set(results.metadata) <= approvals | calls
            ):
                raise GalaxieError('invalid')
            results.to_tool_call_results()
            return results
        except Exception:
            raise GalaxieError('invalid') from None

    async def _run_stream(
        self, prompt: str | None, options: dict[str, Any], on_stream: Callable[[str, Any], None],
    ) -> AgentRunResult[Any]:
        request_index = 0
        async with self.agent.iter(prompt, **options) as run:
            async for node in run:
                if Agent.is_model_request_node(node):
                    on_stream('updates', {'kind': 'model-request', 'index': request_index})
                    request_index += 1
                    async with node.stream(run.ctx) as events:
                        async for event in events:
                            if isinstance(event, PartStartEvent) and isinstance(event.part, TextPart):
                                text = event.part.content
                            elif isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                                text = event.delta.content_delta
                            else:
                                continue
                            if text:
                                on_stream('messages', [{'type': 'ai', 'content': text}, {}])
                elif Agent.is_call_tools_node(node):
                    for index, part in enumerate(node.model_response.parts):
                        if isinstance(part, ToolCallPart):
                            on_stream('updates', {'kind': 'tool-call', 'name': part.tool_name, 'index': index})
            result = run.result
        if result is None:
            raise GalaxieError('executor_error')
        return result

    async def run(
        self, input: Any, conversation_id: str, steps: int, *,
        on_stream: Callable[[str, Any], None] | None = None,
        resume: dict[str, Any] | None = None,
    ) -> Any:
        _uninstrumented(self.agent)
        Agent.instrument_all(False)
        if not isinstance(conversation_id, str) or not conversation_id:
            raise GalaxieError('invalid')
        state = self._conversations.setdefault(conversation_id, _Conversation())
        options = {'conversation_id': conversation_id, 'usage_limits': UsageLimits(request_limit=steps), 'infer_name': False}
        position = state.position
        if resume is not None:
            pause = state.pending
            if pause is None or resume.get('interactionId') != pause.interaction['id']:
                raise GalaxieError('stale')
            if set(resume) != {'interactionId', 'action', 'payload'} or not isinstance(resume['action'], str):
                raise GalaxieError('invalid')
            options['deferred_tool_results'] = self._results(pause.requests, resume['action'], resume['payload'])
            options['message_history'] = pause.messages
            if state.conversation is not None:
                options['usage'] = deepcopy(state.conversation.usage)
                options['usage_limits'] = UsageLimits(request_limit=state.conversation.usage.requests + steps)
            position = pause.position
            prompt = None
        elif self.prompt is None:
            if not isinstance(input, dict) or set(input) != {'prompt'} or not isinstance(input['prompt'], str):
                raise GalaxieError('invalid')
            prompt = input['prompt']
        else:
            prompt = self.prompt(input)
        if resume is None and not isinstance(prompt, str):
            raise GalaxieError('invalid')
        state.pending = None
        token = _positions.set(position)
        with capture_run_messages() as messages:
            try:
                if on_stream is None:
                    result = await self.agent.run(prompt, **options)
                else:
                    result = await self._run_stream(prompt, options, on_stream)
            except UsageLimitExceeded:
                raise GalaxieError('budget_exceeded') from None
            except UnexpectedModelBehavior:
                raise GalaxieError('executor_error') from None
            finally:
                state.position = position + len(messages)
                _positions.reset(token)
        state.conversation = result.conversation
        if isinstance(result.output, DeferredToolRequests):
            try:
                if self.interaction is None:
                    raise GalaxieError('unsupported')
                value = _interaction(self.interaction(result.output))
            except Exception:
                raise GalaxieError('unsupported') from None
            identifier = hashlib.sha256(json.dumps([conversation_id, state.pauses]).encode()).hexdigest()
            state.pauses += 1
            state.pending = _Pause(position, result.all_messages(), result.output, {'id': identifier, 'value': value})
            if on_stream is not None:
                on_stream('updates', {'kind': 'deferred'})
            return None
        return _json(self.output(result.output) if self.output else result.output)


def prepare_executor(value: Any) -> Executor:
    """Accept the entry factory's agent or an explicit executor wrapper."""
    if isinstance(value, Executor):
        _uninstrumented(value.agent)
        _validate_agent(value.agent)
        return value
    if isinstance(value, Agent):
        return Executor(value)
    raise GalaxieError('unsupported')
