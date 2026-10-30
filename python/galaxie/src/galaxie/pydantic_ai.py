# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""pydantic-ai models and capability tools backed by the JavaScript runtime."""

import json
from collections.abc import Callable
from contextvars import ContextVar
from typing import Any

from pydantic_ai import Agent, RunContext, Tool, capture_run_messages
from pydantic_ai.capabilities import Instrumentation
from pydantic_ai.exceptions import UnexpectedModelBehavior, UsageLimitExceeded
from pydantic_ai.messages import (
    ModelMessage, ModelRequest, ModelResponse, ModelResponsePart, RetryPromptPart, SystemPromptPart, TextPart, ToolCallPart, ToolReturnPart, UserPromptPart,
)
from pydantic_ai.models import Model, ModelRequestParameters
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

    async def request(
        self, messages: list[ModelMessage], model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> ModelResponse:
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
        payload = {'role': self.role, 'messages': _messages(messages, parameters), 'options': options}
        reply = await request('model', payload)
        return _reply(reply, messages, {tool['function']['name'] for tool in tools}, self.role)


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

    async def run(self, input: Any, conversation_id: str, steps: int) -> Any:
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
                result = await self.agent.run(prompt, conversation_id=conversation_id, usage_limits=UsageLimits(request_limit=steps), infer_name=False)
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
