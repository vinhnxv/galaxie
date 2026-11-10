# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
import subprocess
import sys

import pytest
from pydantic import BaseModel
from pydantic_ai import Agent, DeferredToolRequests, DeferredToolResults, NativeOutput, PromptedOutput
from pydantic_ai.capabilities import Instrumentation
from pydantic_ai.messages import (
    InstructionPart, ModelRequest, ModelResponse, SystemPromptPart, TextPart,
    ToolCallPart, ToolReturnPart, UserPromptPart,
)
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.instrumented import InstrumentedModel
from pydantic_ai.output import OutputObjectDefinition
from pydantic_ai.toolsets import CombinedToolset, FunctionToolset
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


def approval_executor(interaction=None):
    agent = Agent(GalaxieModel('answer'), output_type=[str, DeferredToolRequests])
    executed = []

    @agent.tool_plain(requires_approval=True)
    async def save(value: int) -> str:
        executed.append(value)
        return 'saved'

    def display(requests):
        return {'surfaceId': 'main', 'viewRevision': 'approval-1', 'component': 'tests.Approval/v1',
                'props': {'arguments': requests.approvals[0].args_as_json_str()}}

    return Executor(agent, interaction=interaction or display), executed


@pytest.mark.parametrize('action,expected', [('approve', [7]), ('deny', [])])
def test_deferred_approval_pauses_and_resumes_once(action, expected):
    transport_for([{'content': '', 'toolCalls': [tool_call('save', '{"value":7}')]}, {'content': 'done'}])
    executor, executed = approval_executor()

    async def run():
        assert await executor.run({'prompt': 'save'}, 'conversation', 5) is None
        pending = executor.pending('conversation')
        assert pending is not None
        assert pending['value']['props'] == {'arguments': '{"value":7}'}
        assert executed == []
        answer = {'interactionId': pending['id'], 'action': action, 'payload': {'toolCallIds': ['call_1']}}
        assert await executor.run(None, 'conversation', 5, resume=answer) == 'done'
        assert executor.pending('conversation') is None
        with pytest.raises(GalaxieError) as error:
            await executor.run(None, 'conversation', 5, resume=answer)
        assert error.value.code == 'stale'

    asyncio.run(run())
    assert executed == expected


def test_conversation_snapshot_restores_history_usage_and_the_same_pending_approval():
    transport_for([{'content': '', 'toolCalls': [tool_call('save', '{"value":7}')]}])
    original, _ = approval_executor()

    async def run():
        await original.run({'prompt': 'save'}, 'stable-conversation', 5)
        pending = original.pending('stable-conversation')
        assert pending is not None
        checkpoint, metadata = original._snapshot('stable-conversation')
        conversation = json.loads(checkpoint)
        assert conversation['conversation_id'] == 'stable-conversation'
        assert conversation['usage']['requests'] == 1
        assert conversation['deferred_tool_requests']['approvals'][0]['tool_call_id'] == 'call_1'
        restored, executed = approval_executor()
        assert restored._restore(checkpoint, metadata) == 'stable-conversation'
        assert restored.pending('stable-conversation') == pending
        seen = []
        transport_for([{'content': 'done'}], seen)
        assert await restored.run(None, 'stable-conversation', 5, resume={
            'interactionId': pending['id'], 'action': 'approve', 'payload': {'toolCallIds': ['call_1']},
        }) == 'done'
        assert executed == [7]
        assert seen[0]['messages'][0] == {'role': 'user', 'content': 'save'}
        checkpoint, metadata = restored._snapshot('stable-conversation')
        assert json.loads(checkpoint)['usage']['requests'] == 2
        completed, _ = approval_executor()
        completed._restore(checkpoint, metadata)
        assert completed.pending('stable-conversation') is None

    asyncio.run(run())


@pytest.mark.parametrize('mutation', ['bytes', 'missing-history', 'missing-identity', 'invalid-pending', 'wrong-position', 'wrong-version', 'duplicate-call', 'tampered-props'])
def test_corrupted_conversation_snapshot_fails_closed_without_losing_other_conversations(mutation):
    transport_for([{'content': '', 'toolCalls': [tool_call('save', '{"value":7}')]}])
    original, _ = approval_executor()
    asyncio.run(original.run({'prompt': 'save'}, 'saved', 5))
    checkpoint, metadata = original._snapshot('saved')
    conversation, meta = json.loads(checkpoint), json.loads(metadata)
    if mutation == 'bytes':
        checkpoint = b'private corrupt bytes'
    elif mutation == 'missing-history':
        conversation['messages'] = 'invalid'
    elif mutation == 'missing-identity':
        del conversation['conversation_id']
    elif mutation == 'invalid-pending':
        meta['pending']['interaction']['value']['component'] = 'private invalid'
    elif mutation == 'wrong-position':
        meta['pending']['position'] += 1
    elif mutation == 'wrong-version':
        meta['v'] = True
    elif mutation == 'tampered-props':
        meta['pending']['interaction']['value']['props'] = {'misleading': True}
    else:
        conversation['deferred_tool_requests']['approvals'] *= 2
    if mutation != 'bytes':
        checkpoint = json.dumps(conversation).encode()
    restored, executed = approval_executor()
    restored._restore(*original._snapshot('saved'))
    before = restored.pending('saved')
    with pytest.raises(GalaxieError) as error:
        restored._restore(checkpoint, json.dumps(meta).encode())
    assert (error.value.code, str(error.value)) == ('unrecoverable', 'Stored state cannot be recovered.')
    assert restored.pending('saved') == before
    assert executed == []


@pytest.mark.parametrize('answer,code', [
    ({'interactionId': 'wrong', 'action': 'approve', 'payload': {'toolCallIds': ['call_1']}}, 'stale'),
    ({'action': 'other', 'payload': {'toolCallIds': ['call_1']}}, 'invalid'),
    ({'action': 'approve', 'payload': {'toolCallIds': []}}, 'invalid'),
    ({'action': 'approve', 'payload': {'toolCallIds': ['call_1', 'call_1']}}, 'invalid'),
])
def test_deferred_default_resume_fails_closed(answer, code):
    transport_for([{'content': '', 'toolCalls': [tool_call('save', '{"value":7}')]}])
    executor, executed = approval_executor()

    async def run():
        await executor.run({'prompt': 'save'}, 'conversation', 5)
        pending = executor.pending('conversation')
        assert pending is not None
        with pytest.raises(GalaxieError) as error:
            await executor.run(None, 'conversation', 5, resume={'interactionId': pending['id'], **answer})
        assert error.value.code == code
        assert executor.pending('conversation') == pending

    asyncio.run(run())
    assert executed == []


@pytest.mark.parametrize('value', [
    {'bad': 'private text'},
    {'surfaceId': 'main', 'viewRevision': 'r1', 'component': 'invalid', 'props': {}},
    {'surfaceId': 'main', 'viewRevision': 'r1', 'component': 'tests.Approval/v1', 'props': {'value': float('nan')}},
    {'surfaceId': 'main', 'viewRevision': 'r1', 'component': 'tests.Approval/v1', 'props': {'value': (1, 2)}},
])
def test_invalid_deferred_interaction_has_a_fixed_unsupported_error(value):
    transport_for([{'content': '', 'toolCalls': [tool_call('save', '{"value":7}')]}])
    executor, executed = approval_executor(lambda _: value)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'save'}, 'conversation', 5))
    assert (error.value.code, str(error.value)) == ('unsupported', 'This operation is unsupported.')
    assert executor.pending('conversation') is None
    assert executed == []


@pytest.mark.parametrize('results', [
    None, DeferredToolResults(), DeferredToolResults(approvals={'extra': True}),
    DeferredToolResults(approvals=json.loads('{"call_1":"approve"}')),
    DeferredToolResults(approvals={'call_1': True}, calls={'extra': 6}),
])
def test_author_resume_must_cover_every_deferred_call_before_any_tool_runs(results):
    transport_for([{'content': '', 'toolCalls': [tool_call('save', '{"value":7}')]}])
    executor, executed = approval_executor()
    executor.resume = lambda *_: results

    async def run():
        await executor.run({'prompt': 'save'}, 'conversation', 5)
        pending = executor.pending('conversation')
        assert pending is not None
        with pytest.raises(GalaxieError) as error:
            await executor.run(None, 'conversation', 5, resume={
                'interactionId': pending['id'], 'action': 'resolve', 'payload': {},
            })
        assert (error.value.code, str(error.value)) == ('invalid', 'The request is invalid.')
        assert executor.pending('conversation') == pending

    asyncio.run(run())
    assert executed == []


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


ANSWER_SCHEMA = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value'], 'title': 'Answer'}


def test_executor_validates_tool_output_and_retries_as_ordinary_model_calls():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [tool_call('final_result', '{"value":"wrong"}', 'output_1')]},
        {'content': '', 'toolCalls': [tool_call('final_result', '{"value":7}', 'output_2')]},
    ], seen)
    executor = prepare_executor(Agent(GalaxieModel('answer'), output_type=Answer, retries=1))
    assert asyncio.run(executor.run({'prompt': 'question'}, 'conversation', 5)) == {'value': 7}
    assert len(seen) == 2
    assert all(set(payload['options']) == {'tools', 'toolChoice'} for payload in seen)
    assert seen[0]['options']['tools'][0]['function']['name'] == 'final_result'
    assert seen[0]['options']['toolChoice'] == 'required'
    assert seen[1]['messages'][-1]['role'] == 'tool'
    assert json.loads(seen[1]['messages'][-1]['content'])['error'][0]['type'] == 'int_parsing'


def test_exhausted_validation_retries_have_a_fixed_error():
    transport_for([{'content': '', 'toolCalls': [tool_call('final_result', '{"value":"wrong"}', 'output_1')]}])
    with pytest.raises(GalaxieError) as error:
        asyncio.run(prepare_executor(Agent(GalaxieModel('answer'), output_type=Answer, retries=0)).run({'prompt': 'question'}, 'conversation', 5))
    assert error.value.code == 'executor_error'
    assert str(error.value) == 'The executor or agent code failed.'


def test_prompted_output_parses_text():
    transport_for([{'content': '{"value":8}'}])
    agent = Agent(GalaxieModel('answer'), output_type=PromptedOutput(Answer))
    assert asyncio.run(prepare_executor(agent).run({'prompt': 'question'}, 'conversation', 5)) == {'value': 8}


def test_native_output_sends_only_the_schema_constraint_and_validates_the_reply():
    seen = []
    transport_for([{'content': '{"value":8}'}], seen)
    agent = Agent(GalaxieModel('answer'), output_type=NativeOutput(Answer))
    assert asyncio.run(prepare_executor(agent).run({'prompt': 'question'}, 'conversation', 5)) == {'value': 8}
    assert seen[0]['options'] == {'jsonSchema': ANSWER_SCHEMA}
    assert all('properties' not in message['content'] and 'schema' not in message['content'] for message in seen[0]['messages'])


@pytest.mark.parametrize('retries', [1, 2])
def test_native_output_validation_retries_carry_growing_repair_indices(retries):
    seen = []
    transport_for([{'content': '{"value":"x"}'}] * retries + [{'content': '{"value":8}'}], seen)
    executor = prepare_executor(Agent(GalaxieModel('answer'), output_type=NativeOutput(Answer), retries=retries))
    assert asyncio.run(executor.run({'prompt': 'question'}, 'conversation', 5)) == {'value': 8}
    assert [payload['options'].get('repairAttempt') for payload in seen] == [None, *range(1, retries + 1)]
    for payload in seen[1:]:
        assert payload['options']['jsonSchema'] == ANSWER_SCHEMA
        assert payload['messages'][-1]['role'] == 'user'
        assert 'int_parsing' in payload['messages'][-1]['content']
        assert '<validation_errors>' in payload['messages'][-1]['content']


def test_native_output_router_refusal_propagates_without_another_retry():
    seen = []
    async def transport(raw):
        message = json.loads(raw)
        seen.append(message['payload'])
        if message['payload']['options'].get('repairAttempt'):
            return json.dumps({**message, 'kind': 'response', 'ok': False, 'error': {'code': 'invalid'}})
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': {'content': '{"value":"x"}'}})
    _bridge.install_transport(transport)
    executor = prepare_executor(Agent(GalaxieModel('answer'), output_type=NativeOutput(Answer), retries=2))
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'question'}, 'conversation', 5))
    assert (error.value.code, str(error.value)) == ('invalid', 'The request is invalid.')
    assert len(seen) == 2


def test_stream_native_output_uses_checked_text_deltas_and_the_schema_constraint():
    seen = []
    streaming_transport([{'content': '{"value": '}, {'content': '8}'}], {'content': '{"value": 8}'}, seen)
    streams = []
    executor = prepare_executor(Agent(GalaxieModel('answer'), output_type=NativeOutput(Answer)))
    assert asyncio.run(executor.run({'prompt': 'question'}, 'conversation', 5, on_stream=lambda mode, data: streams.append((mode, data)))) == {'value': 8}
    assert seen[0]['options'] == {'jsonSchema': ANSWER_SCHEMA, 'stream': True}
    assert [data[0]['content'] for mode, data in streams if mode == 'messages'] == ['{"value": ', '8}']


@pytest.mark.parametrize('shape', ['capability', 'plain-tool', 'deferred', 'template', 'empty-template', 'toolset'])
@pytest.mark.parametrize('prepare', [prepare_executor, Executor])
def test_native_output_unprovable_shapes_fail_at_prepare_without_bridge_traffic(shape, prepare):
    seen = []
    transport_for([], seen)
    output = [NativeOutput(Answer), DeferredToolRequests] if shape == 'deferred' else NativeOutput(Answer, template='{schema}' if shape == 'template' else '' if shape == 'empty-template' else None)
    tools = [capability_tool('lookup', 'docs.search@1', {'type': 'object'})] if shape == 'capability' else []
    toolsets = [CombinedToolset([FunctionToolset()])] if shape == 'toolset' else []
    agent = Agent(GalaxieModel('answer'), output_type=output, tools=tools, toolsets=toolsets)
    if shape == 'plain-tool':
        @agent.tool_plain
        def lookup() -> str:
            return 'unused'
    with pytest.raises(GalaxieError) as error:
        prepare(agent)
    assert (error.value.code, str(error.value)) == ('unsupported', 'This operation is unsupported.')
    assert seen == []


@pytest.mark.parametrize('settings', [{'temperature': 0}, {'openai_reasoning_effort': 'high'}, lambda ctx: {'stop_sequences': ['x']}])
@pytest.mark.parametrize('prepare', [prepare_executor, Executor])
def test_agent_model_settings_fail_at_prepare_without_bridge_traffic(settings, prepare):
    seen = []
    transport_for([], seen)
    with pytest.raises(GalaxieError) as error:
        prepare(Agent(GalaxieModel('answer'), model_settings=settings))
    assert error.value.code == 'unsupported'
    assert seen == []


def test_prepare_revalidates_an_executor_after_agent_configuration_changes():
    executor = Executor(Agent(GalaxieModel('answer')))
    executor.agent.model_settings = {'temperature': 0}
    with pytest.raises(GalaxieError) as error:
        prepare_executor(executor)
    assert error.value.code == 'unsupported'


def test_native_output_allows_template_false_and_stop_sequences():
    seen = []
    transport_for([{'content': '{"value":8}'}], seen)
    executor = prepare_executor(Agent(GalaxieModel('answer'), output_type=NativeOutput(Answer, template=False), model_settings={'stop_sequences': ['END']}))
    assert asyncio.run(executor.run({'prompt': 'question'}, 'conversation', 5)) == {'value': 8}
    assert seen[0]['options'] == {'jsonSchema': ANSWER_SCHEMA, 'stop': ['END']}


@pytest.mark.parametrize('shape', ['tools', 'template'])
def test_native_output_request_backstop_refuses_tools_and_prompted_templates(shape):
    seen = []
    transport_for([], seen)
    parameters = ModelRequestParameters(
        output_mode='native', output_object=OutputObjectDefinition(json_schema=Answer.model_json_schema(), name='Answer'),
        function_tools=[ToolDefinition(name='lookup')] if shape == 'tools' else [],
        prompted_output_template='{schema}' if shape == 'template' else None,
    )
    with pytest.raises(GalaxieError) as error:
        asyncio.run(GalaxieModel('answer').request([], None, parameters))
    assert error.value.code == 'unsupported'
    assert seen == []


@pytest.mark.parametrize('settings', [{'temperature': 0}, {'thinking': True}, {'cache': True}])
def test_model_owned_settings_are_refused_before_merging_or_stripping(settings):
    seen = []
    transport_for([], seen)
    model = GalaxieModel('answer')
    model._settings = settings
    with pytest.raises(GalaxieError) as error:
        asyncio.run(model.request([], None, ModelRequestParameters()))
    assert error.value.code == 'unsupported'
    assert seen == []


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
    assert seen[-1]['payload'] == {'name': 'docs.search@1', 'input': {'query': 'x'}, 'effectScope': 'pydantic-ai/session-fixed/1/0', 'tool': True}


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


def streaming_transport(chunks, reply, seen=None):
    async def transport(raw):
        message = json.loads(raw)
        if seen is not None:
            seen.append(message['payload'])
        for chunk in chunks:
            _bridge.receive_model_chunk(json.dumps({
                **message, 'kind': 'notify', 'op': 'model-chunk', 'payload': chunk,
            }))
            await asyncio.sleep(0)
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})
    _bridge.install_transport(transport)


def test_streamed_text_arrives_before_completion_and_usage_is_final():
    seen = []
    streaming_transport([{'content': 'first '}, {'content': 'second'}], {
        'content': 'first second', 'usage': {'input_tokens': 3, 'output_tokens': 2, 'total_tokens': 5},
    }, seen)
    async def run():
        from pydantic_ai.messages import PartStartEvent, PartDeltaEvent, TextPartDelta
        deltas = []
        async with GalaxieModel('answer').request_stream([], {'stop_sequences': ['stop']}, ModelRequestParameters()) as response:
            async for event in response:
                if isinstance(event, PartStartEvent) and isinstance(event.part, TextPart):
                    deltas.append(event.part.content)
                elif isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                    deltas.append(event.delta.content_delta)
            assert deltas == ['first ', 'second']
            assert response.get().parts == [TextPart('first second')]
            assert response.get().usage.input_tokens == 3
            assert response.get().usage.output_tokens == 2
    asyncio.run(run())
    assert seen[0]['options'] == {'stream': True, 'stop': ['stop']}


@pytest.mark.parametrize('reply', [
    {'content': 'different'},
    {'content': 'joined', 'toolCalls': [tool_call('lookup', '{}')]},
])
def test_stream_final_reply_must_match_joined_deltas(reply):
    streaming_transport([{'content': 'joined'}], reply)
    async def run():
        async with GalaxieModel('answer').request_stream([], None, ModelRequestParameters(function_tools=[ToolDefinition(name='lookup')])) as response:
            async for _ in response:
                pass
    with pytest.raises(GalaxieError) as error:
        asyncio.run(run())
    assert error.value.code == 'invalid'


def test_streamed_tool_fragments_are_reassembled_and_validated_before_execution():
    chunks = [
        {'content': '', 'toolCalls': [{'index': 0, 'id': 'call_', 'type': 'function', 'function': {'name': 'look', 'arguments': '{"query":'}}]},
        {'content': '', 'toolCalls': [{'index': 0, 'id': '1', 'type': 'function', 'function': {'name': 'up', 'arguments': ' "x"}'}}]},
    ]
    streaming_transport(chunks, {'content': '', 'toolCalls': [tool_call('lookup', '{"query":"x"}')]})
    async def run():
        async with GalaxieModel('answer').request_stream([], None, ModelRequestParameters(function_tools=[ToolDefinition(name='lookup')])) as response:
            async for _ in response:
                pass
            part = response.get().parts[0]
            assert isinstance(part, ToolCallPart)
            assert (part.tool_name, part.tool_call_id, part.args_as_dict()) == ('lookup', 'call_1', {'query': 'x'})
    asyncio.run(run())


def test_abandoning_a_stream_cancels_and_drains_the_bridge_request():
    cancelled = []
    async def transport(raw: str) -> str:
        message = json.loads(raw)
        _bridge.receive_model_chunk(json.dumps({**message, 'kind': 'notify', 'op': 'model-chunk', 'payload': {'content': 'first'}}))
        try:
            return await asyncio.Future()
        finally:
            cancelled.append(True)
    _bridge.install_transport(transport)
    async def run():
        async with GalaxieModel('answer').request_stream([], None, ModelRequestParameters()) as response:
            async for _ in response:
                break
        assert not _bridge._streams
    asyncio.run(run())
    assert cancelled == [True]


@pytest.mark.parametrize('raw,final', [
    ('{"value":1.0}', '{"value":1}'),
    ('{"value":1e0}', '{"value":1}'),
    ('{"value":-0.0}', '{"value":0}'),
    ('{"value":9007199254740993}', '{"value":9007199254740992}'),
])
def test_streamed_arguments_match_the_javascript_final_number_representation(raw, final):
    streaming_transport([{'content': '', 'toolCalls': [{
        'index': 0, 'id': 'one', 'type': 'function', 'function': {'name': 'lookup', 'arguments': raw},
    }]}], {'content': '', 'toolCalls': [tool_call('lookup', final, 'one')]})
    async def run():
        async with GalaxieModel('answer').request_stream([], None, ModelRequestParameters(function_tools=[ToolDefinition(name='lookup')])) as response:
            async for _ in response:
                pass
            part = response.get().parts[0]
            assert isinstance(part, ToolCallPart)
            assert part.args == final
    asyncio.run(run())


def test_streamed_argument_normalization_keeps_booleans_distinct_from_numbers():
    streaming_transport([{'content': '', 'toolCalls': [{
        'index': 0, 'id': 'one', 'type': 'function', 'function': {'name': 'lookup', 'arguments': '{"value":true}'},
    }]}], {'content': '', 'toolCalls': [tool_call('lookup', '{"value":1}', 'one')]})
    async def run():
        async with GalaxieModel('answer').request_stream([], None, ModelRequestParameters(function_tools=[ToolDefinition(name='lookup')])) as response:
            async for _ in response:
                pass
    with pytest.raises(GalaxieError) as error:
        asyncio.run(run())
    assert error.value.code == 'invalid'


@pytest.mark.parametrize('final_order', [('one', 'zero'), ('zero', 'one')])
def test_streamed_calls_align_by_identity_when_indices_arrive_out_of_order(final_order):
    calls = {identifier: tool_call('lookup', '{}', identifier) for identifier in final_order}
    streaming_transport([{'content': '', 'toolCalls': [
        {'index': index, **calls[identifier]} for index, identifier in [(1, 'one'), (0, 'zero')]
    ]}], {'content': '', 'toolCalls': [calls[identifier] for identifier in final_order]})
    async def run():
        async with GalaxieModel('answer').request_stream([], None, ModelRequestParameters(function_tools=[ToolDefinition(name='lookup')])) as response:
            async for _ in response:
                pass
            assert [part.tool_call_id for part in response.get().parts if isinstance(part, ToolCallPart)] == list(final_order)
    asyncio.run(run())


def test_effect_scopes_stay_distinct_across_approval_resumes_and_fresh_starts():
    scopes = []
    replies = iter([
        {'content': '', 'toolCalls': [tool_call('save', '{"value":1}', 'c1')]},
        {'content': '', 'toolCalls': [tool_call('save', '{"value":2}', 'c2')]},
        {'content': 'done'},
        {'content': '', 'toolCalls': [tool_call('save', '{"value":3}', 'c1')]},
        {'content': 'done'},
    ])

    async def transport(raw):
        message = json.loads(raw)
        if message['op'] == 'capability':
            scopes.append(message['payload']['effectScope'])
            reply = {'saved': True}
        else:
            reply = next(replies)
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})

    _bridge.install_transport(transport)
    tool = capability_tool('save', 'save@1', {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']})
    tool.requires_approval = True
    executor = Executor(
        Agent(GalaxieModel('answer'), output_type=[str, DeferredToolRequests], tools=[tool]),
        interaction=lambda requests: {'surfaceId': 'main', 'viewRevision': '1', 'component': 'tests.Approve/v1', 'props': {}},
    )

    def pending_id():
        pending = executor.pending('c')
        assert pending is not None
        return pending['id']

    async def scenario():
        ids = []
        await executor.run({'prompt': 'first'}, 'c', 9)
        ids.append(pending_id())
        await executor.run(None, 'c', 9, resume={'interactionId': ids[-1], 'action': 'approve', 'payload': {'toolCallIds': ['c1']}})
        ids.append(pending_id())
        assert await executor.run(None, 'c', 9, resume={'interactionId': ids[-1], 'action': 'approve', 'payload': {'toolCallIds': ['c2']}}) == 'done'
        await executor.run({'prompt': 'second'}, 'c', 9)
        ids.append(pending_id())
        assert await executor.run(None, 'c', 9, resume={'interactionId': ids[-1], 'action': 'approve', 'payload': {'toolCallIds': ['c1']}}) == 'done'
        return ids

    ids = asyncio.run(scenario())
    assert scopes == ['pydantic-ai/c/1/0', 'pydantic-ai/c/3/0', 'pydantic-ai/c/7/0']
    assert len(set(ids)) == 3


def test_snapshot_bound_to_one_session_is_rejected_for_another():
    transport_for([{'content': '', 'toolCalls': [tool_call('save', '{"value":7}')]}])
    original, _ = approval_executor()
    asyncio.run(original.run({'prompt': 'save'}, 'saved', 5))
    checkpoint, metadata = original._snapshot('saved', 'session-a')
    restored, executed = approval_executor()
    with pytest.raises(GalaxieError) as error:
        restored._restore(checkpoint, metadata, 'session-b')
    assert error.value.code == 'unrecoverable'
    assert restored.pending('saved') is None
    assert restored._restore(checkpoint, metadata, 'session-a') == 'saved'
    assert executed == []
