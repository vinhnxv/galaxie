# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""pydantic-ai models and capability tools backed by the JavaScript runtime."""

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any

from pydantic_ai import Agent, AgentRunResult, RunContext, Tool, capture_run_messages
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
            'supports_json_schema_output': False, 'supports_json_object_output': False,
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
                        return await capabilities.call(capability, arguments, effect_scope=scope)
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


class Executor:
    """Run an agent with explicit input and output projections."""

    def __init__(
        self, agent: Agent, *, prompt: Callable[[Any], str] | None = None,
        output: Callable[[Any], Any] | None = None,
    ) -> None:
        if not isinstance(agent, Agent):
            raise GalaxieError('unsupported')
        _uninstrumented(agent)
        self.agent = agent
        self.prompt = prompt
        self.output = output
        self._conversations: dict[str, int] = {}
        agent.instrument = False

    async def _run_stream(
        self, prompt: str, options: dict[str, Any], on_stream: Callable[[str, Any], None],
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
    ) -> Any:
        _uninstrumented(self.agent)
        Agent.instrument_all(False)
        if self.prompt is None:
            if not isinstance(input, dict) or set(input) != {'prompt'} or not isinstance(input['prompt'], str):
                raise GalaxieError('invalid')
            prompt = input['prompt']
        else:
            prompt = self.prompt(input)
        if not isinstance(prompt, str) or not isinstance(conversation_id, str) or not conversation_id:
            raise GalaxieError('invalid')
        position = self._conversations.get(conversation_id, 0)
        token = _positions.set(position)
        with capture_run_messages() as messages:
            try:
                options = {'conversation_id': conversation_id, 'usage_limits': UsageLimits(request_limit=steps), 'infer_name': False}
                if on_stream is None:
                    result = await self.agent.run(prompt, **options)
                else:
                    result = await self._run_stream(prompt, options, on_stream)
            except UsageLimitExceeded:
                raise GalaxieError('budget_exceeded') from None
            except UnexpectedModelBehavior:
                raise GalaxieError('executor_error') from None
            finally:
                self._conversations[conversation_id] = position + len(messages)
                _positions.reset(token)
        return _json(self.output(result.output) if self.output else result.output)


def prepare_executor(value: Any) -> Executor:
    """Accept the entry factory's agent or an explicit executor wrapper."""
    if isinstance(value, Executor):
        _uninstrumented(value.agent)
        return value
    if isinstance(value, Agent):
        return Executor(value)
    raise GalaxieError('unsupported')
