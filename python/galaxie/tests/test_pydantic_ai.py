# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
import subprocess
import sys

import pytest
from pydantic import BaseModel
from pydantic_ai import Agent, NativeOutput, PromptedOutput
from pydantic_ai.capabilities import Instrumentation
from pydantic_ai.exceptions import UserError
from pydantic_ai.messages import (
    InstructionPart, ModelRequest, ModelResponse, SystemPromptPart, TextPart,
    ToolCallPart, ToolReturnPart, UserPromptPart,
)
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.instrumented import InstrumentedModel
from pydantic_ai.tools import ToolDefinition

from galaxie import GalaxieError, _bridge
from galaxie.pydantic_ai import GalaxieModel, Executor, capability_tool, prepare_executor


def transport_for(replies, seen=None):
    replies = iter(replies)
    async def transport(raw):
        message = json.loads(raw)
        if seen is not None:
            seen.append(message['payload'])
        reply = next(replies)
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})
    _bridge.install_transport(transport)


def tool_call(name, arguments, identifier='call_1'):
    return {'id': identifier, 'type': 'function', 'function': {'name': name, 'arguments': arguments}}


def test_text_reply_and_usage_are_mapped_without_a_provider():
    seen = []
    transport_for([{'content': 'answer', 'usage': {'input_tokens': 3, 'output_tokens': 2, 'total_tokens': 5}}], seen)
    model = GalaxieModel('answer')
    response = asyncio.run(model.request([ModelRequest(parts=[UserPromptPart('question')])], None, ModelRequestParameters()))
    assert response.parts == [TextPart('answer')]
    assert response.usage.input_tokens == 3
    assert response.usage.output_tokens == 2
    assert model.provider is None
    assert seen == [{'role': 'answer', 'messages': [{'role': 'user', 'content': 'question'}], 'options': {}}]


def test_instruction_tool_return_and_empty_response_mapping():
    seen = []
    transport_for([{'content': 'done'}], seen)
    messages = [
        ModelRequest(parts=[SystemPromptPart('system'), UserPromptPart('question')]),
        ModelResponse(parts=[]),
        ModelResponse(parts=[ToolCallPart('lookup', '{"query":"x"}', tool_call_id='old')]),
        ModelRequest(parts=[ToolReturnPart('lookup', {'value': 2}, tool_call_id='old')]),
    ]
    asyncio.run(GalaxieModel('answer').request(messages, None, ModelRequestParameters(instruction_parts=[InstructionPart('instructions')])))
    assert seen[0]['messages'] == [
        {'role': 'system', 'content': 'system'},
        {'role': 'system', 'content': 'instructions'},
        {'role': 'user', 'content': 'question'},
        {'role': 'assistant', 'content': '', 'toolCalls': [tool_call('lookup', '{"query":"x"}', 'old')]},
        {'role': 'tool', 'content': '{"value":2}', 'tool_call_id': 'old'},
    ]


def test_tool_definition_and_tool_call_round_trip():
    seen = []
    transport_for([{'content': '', 'toolCalls': [tool_call('lookup', '{"query":"x"}')]}], seen)
    params = ModelRequestParameters(function_tools=[ToolDefinition(name='lookup', parameters_json_schema={'type': 'object'}, description='Look up')])
    response = asyncio.run(GalaxieModel('answer').request([], None, params))
    part = response.parts[0]
    assert isinstance(part, ToolCallPart)
    assert (part.tool_name, part.args, part.tool_call_id) == ('lookup', '{"query":"x"}', 'call_1')
    assert seen[0]['options']['tools'] == [{'type': 'function', 'function': {'name': 'lookup', 'description': 'Look up', 'parameters': {'type': 'object'}}}]


@pytest.mark.parametrize('calls', [
    [tool_call('lookup', '{}', '')], [tool_call('lookup', '{}', 'x' * 129)],
    [tool_call('missing', '{}')], [tool_call('lookup', '{}'), tool_call('lookup', '{}')],
    [tool_call('lookup', '{}', 'old')],
])
def test_invalid_tool_id_or_name_is_rejected_before_execution(calls):
    transport_for([{'content': '', 'toolCalls': calls}])
    with pytest.raises(GalaxieError) as error:
        asyncio.run(GalaxieModel('answer').request(
            [ModelResponse(parts=[ToolCallPart('lookup', '{}', tool_call_id='old')])], None,
            ModelRequestParameters(function_tools=[ToolDefinition(name='lookup')]),
        ))
    assert error.value.code == 'invalid'


def test_invalid_usage_is_rejected():
    transport_for([{'content': 'answer', 'usage': {'input_tokens': 3, 'output_tokens': 2, 'total_tokens': 4}}])
    with pytest.raises(GalaxieError) as error:
        asyncio.run(GalaxieModel('answer').request([], None, ModelRequestParameters()))
    assert error.value.code == 'invalid'


class Answer(BaseModel):
    value: int


def test_executor_validates_tool_output_and_retries_as_ordinary_model_calls():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [tool_call('final_result', '{"value":"wrong"}', 'output_1')]},
        {'content': '', 'toolCalls': [tool_call('final_result', '{"value":7}', 'output_2')]},
    ], seen)
    executor = prepare_executor(Agent(GalaxieModel('answer'), output_type=Answer, retries=1))
    assert asyncio.run(executor.run({'prompt': 'question'}, 'conversation', 5)) == {'value': 7}
    assert len(seen) == 2
    assert seen[1]['messages'][-1]['role'] == 'tool'
    assert json.loads(seen[1]['messages'][-1]['content'])['error'][0]['type'] == 'int_parsing'


def test_exhausted_validation_retries_have_a_fixed_error():
    transport_for([{'content': '', 'toolCalls': [tool_call('final_result', '{"value":"wrong"}', 'output_1')]}])
    with pytest.raises(GalaxieError) as error:
        asyncio.run(prepare_executor(Agent(GalaxieModel('answer'), output_type=Answer, retries=0)).run({'prompt': 'question'}, 'conversation', 5))
    assert error.value.code == 'executor_error'
    assert str(error.value) == 'The executor or agent code failed.'


def test_prompted_output_parses_text_and_native_output_remains_unsupported():
    transport_for([{'content': '{"value":8}'}])
    agent = Agent(GalaxieModel('answer'), output_type=PromptedOutput(Answer))
    assert asyncio.run(prepare_executor(agent).run({'prompt': 'question'}, 'conversation', 5)) == {'value': 8}
    with pytest.raises(UserError, match='Native structured output'):
        asyncio.run(Agent(GalaxieModel('answer'), output_type=NativeOutput(Answer)).run('question'))


def test_capability_tool_has_a_position_derived_scope_and_propagates_denial():
    seen = []
    async def transport(raw):
        message = json.loads(raw)
        seen.append(message)
        if message['op'] == 'capability':
            return json.dumps({**{key: message[key] for key in ['v', 'id', 'op']}, 'kind': 'response', 'ok': False, 'error': {'code': 'denied'}})
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': {'content': '', 'toolCalls': [tool_call('lookup', '{"query":"x"}')]}})
    _bridge.install_transport(transport)
    tool = capability_tool('lookup', 'docs.search@1', {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query']})
    agent = Agent(GalaxieModel('answer'), tools=[tool])
    with pytest.raises(GalaxieError) as error:
        asyncio.run(prepare_executor(agent).run({'prompt': 'question'}, 'session-fixed', 5))
    assert error.value.code == 'denied'
    assert seen[-1]['payload'] == {'name': 'docs.search@1', 'input': {'query': 'x'}, 'effectScope': 'pydantic-ai/session-fixed/1/0'}


def test_executor_custom_projection_and_instrumentation_refusal():
    transport_for([{'content': 'answer'}])
    executor = Executor(Agent(GalaxieModel('answer')), prompt=lambda value: value['question'], output=lambda value: {'answer': value})
    assert asyncio.run(executor.run({'question': 'question'}, 'conversation', 5)) == {'answer': 'answer'}
    agent = Agent(GalaxieModel('answer'))
    agent.instrument = True
    with pytest.raises(GalaxieError) as error:
        prepare_executor(agent)
    assert error.value.code == 'unsupported'
    for agent in [Agent(InstrumentedModel(GalaxieModel('answer'))), Agent(GalaxieModel('answer'), capabilities=[Instrumentation()])]:
        with pytest.raises(GalaxieError) as error:
            prepare_executor(agent)
        assert error.value.code == 'unsupported'
    with pytest.raises(GalaxieError):
        prepare_executor(object())


def test_importing_python_face_does_not_import_a_provider_sdk():
    code = "import galaxie.pydantic_ai, sys; assert 'openai' not in sys.modules"
    subprocess.run([sys.executable, '-I', '-c', code], check=True)


def test_capability_tools_use_distinct_history_positions_and_emit_no_trace_content():
    seen = []
    notifications = []
    replies = iter([
        {'content': '', 'toolCalls': [tool_call('lookup', '{"query":"private first"}', 'call_1')]},
        {'content': '', 'toolCalls': [tool_call('lookup', '{"query":"private second"}', 'call_2')]},
        {'content': 'private answer'},
    ])
    async def transport(raw):
        message = json.loads(raw)
        seen.append(message)
        reply = {'value': 'private result'} if message['op'] == 'capability' else next(replies)
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})
    _bridge.install_transport(transport, notifications.append)
    tool = capability_tool('lookup', 'docs.search@1', {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query']})
    executor = prepare_executor(Agent(GalaxieModel('answer'), tools=[tool]))
    assert asyncio.run(executor.run({'prompt': 'private question'}, 'fixed', 5)) == 'private answer'
    calls = [message['payload'] for message in seen if message['op'] == 'capability']
    assert [call['effectScope'] for call in calls] == ['pydantic-ai/fixed/1/0', 'pydantic-ai/fixed/3/0']
    assert notifications == []


def test_unsupported_content_and_provider_settings_never_reach_the_bridge():
    from pydantic_ai.messages import ThinkingPart
    seen = []
    transport_for([], seen)
    for messages, settings in [
        ([ModelRequest(parts=[UserPromptPart(['multimodal'])])], None),
        ([ModelResponse(parts=[ThinkingPart('reasoning')])], None),
        ([], {'openai_reasoning_effort': 'high'}),
    ]:
        with pytest.raises(GalaxieError) as error:
            asyncio.run(GalaxieModel('answer').request(messages, settings, ModelRequestParameters()))
        assert error.value.code == 'unsupported'
    assert seen == []


def test_explicit_effect_scope_preserves_the_existing_langgraph_config_path():
    from galaxie.capabilities import call
    seen = []
    transport_for([None, None], seen)
    asyncio.run(call('save@1', {}, {'configurable': {'checkpoint_ns': 'existing-namespace'}}))
    asyncio.run(call('save@1', {}, effect_scope='pydantic-ai/session/1/0'))
    assert [item['effectScope'] for item in seen] == ['existing-namespace', 'pydantic-ai/session/1/0']


@pytest.mark.parametrize('fail_after_tool', [False, True])
def test_fresh_starts_keep_distinct_effect_positions_even_after_a_failed_run(fail_after_tool):
    calls = []
    replies = iter([
        {'content': '', 'toolCalls': [tool_call('lookup', '{"value":1}', 'first')]},
        {'content': 'done'},
        {'content': '', 'toolCalls': [tool_call('lookup', '{"value":2}', 'second')]},
        {'content': 'done'},
    ])
    model_calls = 0
    async def transport(raw):
        nonlocal model_calls
        message = json.loads(raw)
        if message['op'] == 'capability':
            calls.append(message['payload'])
            reply = {'value': message['payload']['input']['value']}
        else:
            model_calls += 1
            reply = next(replies)
            if fail_after_tool and model_calls == 2:
                return json.dumps({'v': message['v'], 'kind': 'response', 'id': message['id'], 'op': 'model', 'ok': False, 'error': {'code': 'unavailable'}})
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})
    _bridge.install_transport(transport)
    tool = capability_tool('lookup', 'save@1', {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']})
    executor = prepare_executor(Agent(GalaxieModel('answer'), tools=[tool]))
    if fail_after_tool:
        with pytest.raises(GalaxieError):
            asyncio.run(executor.run({'prompt': 'first'}, 'fixed', 5))
    else:
        assert asyncio.run(executor.run({'prompt': 'first'}, 'fixed', 5)) == 'done'
    assert asyncio.run(executor.run({'prompt': 'second'}, 'fixed', 5)) == 'done'
    assert [item['input'] for item in calls] == [{'value': 1}, {'value': 2}]
    assert calls[0]['effectScope'] != calls[1]['effectScope']


def test_tool_ids_from_previous_starts_may_repeat_with_distinct_scopes():
    calls = []
    replies = iter([
        {'content': '', 'toolCalls': [tool_call('lookup', '{"value":1}')]},
        {'content': 'done'},
        {'content': '', 'toolCalls': [tool_call('lookup', '{"value":2}')]},
        {'content': 'done'},
    ])
    async def transport(raw):
        message = json.loads(raw)
        if message['op'] == 'capability':
            calls.append(message['payload'])
            reply = {'value': 1}
        else:
            reply = next(replies)
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})
    _bridge.install_transport(transport)
    tool = capability_tool('lookup', 'save@1', {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']})
    executor = prepare_executor(Agent(GalaxieModel('answer'), tools=[tool]))
    assert asyncio.run(executor.run({'prompt': 'first'}, 'fixed', 5)) == 'done'
    assert asyncio.run(executor.run({'prompt': 'second'}, 'fixed', 5)) == 'done'
    assert [call['effectScope'] for call in calls] == ['pydantic-ai/fixed/1/0', 'pydantic-ai/fixed/5/0']
