# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from typing import cast

import pytest
from google.adk.agents import LlmAgent, LoopAgent, ParallelAgent, SequentialAgent
from google.adk.apps import App
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.planners import PlanReActPlanner
from google.adk.tools import FunctionTool
from google.genai import types
from pydantic import BaseModel

from galaxie import GalaxieError, _bridge
from galaxie import adk as face
from galaxie.adk import Executor, capability_tool, llm, loop_exit, prepare_executor

PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}


def tool_call(name, arguments, identifier='call_0'):
    return {'id': identifier, 'type': 'function', 'function': {'name': name, 'arguments': arguments}}


def transport_for(replies, seen=None):
    """Answer each request in order; a string reply is a bridge error code."""
    replies = iter(replies)

    async def transport(raw):
        message = json.loads(raw)
        if seen is not None:
            seen.append((message['op'], message['payload']))
        reply = next(replies)
        if isinstance(reply, str):
            return json.dumps({
                'v': message['v'], 'kind': 'response', 'id': message['id'], 'op': message['op'],
                'ok': False, 'error': {'code': reply},
            })
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})

    _bridge.install_transport(transport)


def double():
    return capability_tool('math.double@1', 'math.double@1', PARAMETERS, 'Double an integer.')


def agent(tools=(), **options):
    return LlmAgent(name='root', model=llm('answer'), instruction='Use the tools.', tools=list(tools), **options)


def run(executor, steps=5, prompt='question', session='s1'):
    return asyncio.run(executor.run({'prompt': prompt}, session, steps))


def code_of(call):
    with pytest.raises(GalaxieError) as error:
        call()
    return error.value.code


def test_a_text_reply_maps_to_the_bridge_payload_and_back():
    seen = []
    transport_for([{'content': 'hello', 'usage': {'input_tokens': 2, 'output_tokens': 1, 'total_tokens': 3}}], seen)
    assert run(Executor(agent())) == 'hello'
    assert seen == [('model', {
        'role': 'answer',
        'messages': [{'role': 'system', 'content': seen[0][1]['messages'][0]['content']}, {'role': 'user', 'content': 'question'}],
        'options': {},
    })]
    assert 'Use the tools.' in seen[0][1]['messages'][0]['content']


def test_a_capability_call_runs_once_with_a_scope_and_its_result_reaches_the_model():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}')]},
        {'value': 42},
        {'content': 'done'},
    ], seen)
    assert run(Executor(agent([double()]))) == 'done'
    ops = [op for op, _ in seen]
    assert ops == ['model', 'capability', 'model']
    assert seen[0][1]['options']['tools'] == [{'type': 'function', 'function': {
        'name': 'math_double_1', 'description': 'Double an integer.', 'parameters': PARAMETERS,
    }}]
    assert seen[1][1] == {'name': 'math.double@1', 'input': {'value': 21}, 'effectScope': 'adk-python/s1/root/0/0'}
    messages = seen[2][1]['messages']
    assert messages[-2] == {
        'role': 'assistant', 'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}', 'galaxie-1')],
    }
    assert messages[-1] == {'role': 'tool', 'tool_call_id': 'galaxie-1', 'content': '{"value":42}'}


def test_provider_call_ids_are_replaced_and_two_replies_reusing_one_get_distinct_ids():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":1}')]}, {'value': 2},
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":2}')]}, {'value': 4},
        {'content': 'done'},
    ], seen)
    assert run(Executor(agent([double()]))) == 'done'
    ids = [call['id'] for message in seen[-1][1]['messages'] for call in message.get('toolCalls', [])]
    assert ids == ['galaxie-1', 'galaxie-2']
    assert [payload['effectScope'] for op, payload in seen if op == 'capability'] == [
        'adk-python/s1/root/0/0', 'adk-python/s1/root/1/0',
    ]


def test_a_second_run_in_a_session_continues_after_the_ids_already_used():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":1}')]}, {'value': 2}, {'content': 'one'},
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":2}')]}, {'value': 4}, {'content': 'two'},
    ], seen)
    executor = Executor(agent([double()]))
    assert run(executor, prompt='first') == 'one'
    assert run(executor, prompt='second') == 'two'
    scopes = [payload['effectScope'] for op, payload in seen if op == 'capability']
    assert scopes == ['adk-python/s1/root/0/0', 'adk-python/s1/root/1/0']
    assert 'galaxie-2' in json.dumps(seen[-1][1])


def test_a_tool_name_that_was_not_offered_fails_invalid():
    transport_for([{'content': '', 'toolCalls': [tool_call('other', '{}')]}])
    assert code_of(lambda: run(Executor(agent([double()])))) == 'invalid'


def test_tool_calls_without_offered_tools_fail_unsupported():
    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{}')]}])
    assert code_of(lambda: run(Executor(agent()))) == 'unsupported'


@pytest.mark.parametrize('arguments', ['not json', '[1]'])
def test_malformed_tool_arguments_fail_invalid(arguments):
    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', arguments)]}])
    assert code_of(lambda: run(Executor(agent([double()])))) == 'invalid'


@pytest.mark.parametrize('part', [
    types.Part(inline_data=types.Blob(data=b'x', mime_type='image/png')),
    types.Part(file_data=types.FileData(file_uri='gs://bucket/file', mime_type='text/plain')),
])
def test_non_text_parts_fail_unsupported(part):
    request = LlmRequest(contents=[types.Content(role='user', parts=[part])])
    assert code_of(lambda: face._messages(request)) == 'unsupported'


def test_connect_is_unsupported():
    model = llm('answer')
    assert code_of(lambda: model.connect(LlmRequest())) == 'unsupported'


def test_a_response_schema_reaches_the_model_path_as_the_json_schema_option():
    class Answer(BaseModel):
        answer: str

    seen = []
    transport_for([{'content': '{"answer":"42"}'}], seen)
    root = agent(output_schema=Answer, output_key='result')
    assert run(Executor(root)) == {'answer': '42'}
    assert seen[0][1]['options']['jsonSchema']['properties'] == {'answer': {'title': 'Answer', 'type': 'string'}}


def test_a_gemini_style_schema_is_converted_to_json_schema():
    schema = types.Schema(
        type=types.Type.OBJECT, nullable=False, required=['a'],
        properties={'a': types.Schema(type=types.Type.INTEGER, minimum=1, format='enum', nullable=True)},
    )
    assert face._convert(schema.model_dump(mode='json', by_alias=True, exclude_none=True), 0) == {
        'type': 'object', 'required': ['a'],
        'properties': {'a': {'anyOf': [{'type': 'integer', 'minimum': 1}, {'type': 'null'}]}},
    }


def test_the_step_budget_fails_before_the_next_model_dispatch():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":1}')]}, {'value': 2},
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":2}')]}, {'value': 4},
        {'content': 'never'},
    ], seen)
    assert code_of(lambda: run(Executor(agent([double()])), steps=2)) == 'budget_exceeded'
    assert [op for op, _ in seen] == ['model', 'capability', 'model', 'capability']


def test_a_denied_capability_returns_a_fixed_error_to_the_model():
    seen = []
    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":1}')]}, 'denied', {'content': 'sorry'}], seen)
    assert run(Executor(agent([double()]))) == 'sorry'
    assert json.loads(seen[-1][1]['messages'][-1]['content']) == {'error': 'Policy denied the request.'}


@pytest.mark.parametrize('code', ['budget_exceeded', 'unavailable', 'cancelled', 'fenced', 'stale', 'outcome_unknown'])
def test_a_fatal_capability_error_ends_the_run_and_never_reaches_the_model(code):
    seen = []
    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":1}')]}, code, {'content': 'never'}], seen)
    assert code_of(lambda: run(Executor(agent([double()])))) == code
    assert [op for op, _ in seen] == ['model', 'capability']


def test_a_swallowing_error_callback_still_ends_with_the_fatal_code():
    seen = []
    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":1}')]}, 'unavailable', {'content': 'never'}], seen)

    def swallow(tool, args, tool_context, error):
        return {'swallowed': True}

    assert code_of(lambda: run(Executor(agent([double()], on_tool_error_callback=swallow)))) == 'unavailable'
    assert [op for op, _ in seen] == ['model', 'capability']


def test_a_sibling_tool_is_never_dispatched_after_a_fatal_failure():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":1}', 'a'), tool_call('math_double_1', '{"value":2}', 'b')]},
        'fenced', {'value': 4}, {'content': 'never'},
    ], seen)
    assert code_of(lambda: run(Executor(agent([double()])))) == 'fenced'
    assert [op for op, _ in seen] == ['model', 'capability']


def test_a_raising_model_ends_the_run_with_its_code():
    transport_for(['unavailable'])
    assert code_of(lambda: run(Executor(agent()))) == 'unavailable'


def test_a_failed_run_leaves_the_session_at_its_last_stored_point():
    seen = []
    transport_for([
        {'content': 'first'},
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":1}')]}, 'unavailable',
        {'content': 'second'},
    ], seen)
    executor = Executor(agent([double()]))
    assert run(executor, prompt='one') == 'first'
    assert code_of(lambda: run(executor, prompt='two')) == 'unavailable'
    assert run(executor, prompt='three') == 'second'
    roles = [(message['role'], message['content']) for message in seen[-1][1]['messages'] if message['role'] != 'system']
    assert roles == [('user', 'one'), ('assistant', 'first'), ('user', 'three')]


def test_a_cancelled_run_leaves_the_session_at_its_last_stored_point():
    started = asyncio.Event()

    async def transport(raw):
        message = json.loads(raw)
        started.set()
        await asyncio.sleep(30)
        return raw

    _bridge.install_transport(transport)

    async def scenario():
        executor = Executor(agent())
        task = asyncio.create_task(executor.run({'prompt': 'one'}, 's1', 5))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert executor._sessions.sessions['galaxie']['galaxie']['s1'].events == []

    asyncio.run(scenario())


def test_loop_exit_ends_a_loop_agent_and_a_loop_without_a_bound_is_refused():
    transport_for([{'content': '', 'toolCalls': [tool_call('exit_loop', '{}')]}, {'content': 'ended'}])
    worker = LlmAgent(name='worker', model=llm('answer'), tools=[loop_exit()])
    loop = LoopAgent(name='loop', sub_agents=[worker])
    assert run(Executor(loop)) is not None
    bare = LlmAgent(name='bare', model=llm('answer'))
    assert code_of(lambda: Executor(LoopAgent(name='again', sub_agents=[bare]))) == 'unsupported'
    other = LlmAgent(name='other', model=llm('answer'))
    assert Executor(LoopAgent(name='bounded', sub_agents=[other], max_iterations=2))


def test_exit_loop_is_admitted_only_through_the_helper():
    from google.adk.tools import exit_loop
    root = LlmAgent(name='root', model=llm('answer'), tools=[FunctionTool(exit_loop)])
    assert code_of(lambda: Executor(root)) == 'unsupported'


def test_each_allowed_class_passes():
    one = LlmAgent(name='one', model=llm('answer'), tools=[double()])
    two = LlmAgent(name='two')
    for root in (
        one, SequentialAgent(name='s', sub_agents=[LlmAgent(name='a', model=llm('answer'))]),
        ParallelAgent(name='p', sub_agents=[LlmAgent(name='b', model=llm('answer')), LlmAgent(name='c', model=llm('answer'))]),
        LlmAgent(name='parent', model=llm('answer'), sub_agents=[two]),
    ):
        assert isinstance(prepare_executor(root), Executor)


class Custom(LlmAgent):
    pass


@pytest.mark.parametrize('build', [
    lambda: LlmAgent(name='x', model='gemini-2.5-flash'),
    lambda: LlmAgent(name='x'),
    lambda: Custom(name='x', model=llm('answer')),
    lambda: LlmAgent(name='x', model=llm('answer'), tools=[lambda: None]),
    lambda: LlmAgent(name='x', model=llm('answer'), tools=[FunctionTool(lambda: None)]),
    lambda: LlmAgent(name='x', model=llm('answer'), planner=PlanReActPlanner()),
    lambda: LlmAgent(name='x', model=llm('answer'), mode='task'),
    lambda: LlmAgent(name='x', model=llm('answer'), parallel_worker=True),
    lambda: SequentialAgent(name='s', sub_agents=[LlmAgent(name='a')]),
    lambda: App(name='app', root_agent=LlmAgent(name='x', model=llm('answer'))),
    lambda: 'agent',
])
def test_a_refused_shape_fails_unsupported_at_prepare(build):
    assert code_of(lambda: prepare_executor(build())) == 'unsupported'


def test_a_forged_model_that_copies_the_registry_attribute_fails():
    real = llm('answer')
    forged = face._GalaxieLlm(model='galaxie/answer', role='answer')
    assert real in face._models and forged not in face._models
    assert code_of(lambda: prepare_executor(LlmAgent(name='x', model=forged))) == 'unsupported'


def test_a_sub_agent_inherits_a_registered_parent_model():
    child = LlmAgent(name='child')
    assert prepare_executor(LlmAgent(name='parent', model=llm('answer'), sub_agents=[child]))
    nested = LlmAgent(name='leaf')
    middle = SequentialAgent(name='mid', sub_agents=[nested])
    assert prepare_executor(LlmAgent(name='top', model=llm('answer'), sub_agents=[middle]))


def test_a_tree_deeper_than_sixteen_levels_fails():
    leaf = LlmAgent(name='leaf0', model=llm('answer'))
    for index in range(1, 18):
        leaf = SequentialAgent(name=f'level{index}', sub_agents=[leaf])
    assert code_of(lambda: prepare_executor(leaf)) == 'unsupported'


def test_an_input_other_than_a_prompt_fails_invalid():
    transport_for([])
    executor = Executor(agent())
    for value in (None, {}, {'prompt': ''}, {'prompt': 1}, {'prompt': 'x', 'extra': 1}):
        assert code_of(lambda: asyncio.run(executor.run(value, 's', 3))) == 'invalid'


def test_tool_names_are_sanitized_or_refused():
    assert capability_tool('math.double@1', 'math.double@1', PARAMETERS, 'x').name == 'math_double_1'
    assert capability_tool('1abc', 'cap@1', PARAMETERS, 'x').name == '_1abc'
    for name in ('', 7):
        assert code_of(lambda: capability_tool(cast(str, name), 'cap@1', PARAMETERS, 'x')) == 'invalid'


def test_pydantic_parameters_become_a_json_schema():
    class Args(BaseModel):
        value: int

    declaration = capability_tool('t', 'cap@1', Args, 'x')._get_declaration()
    assert declaration is not None and declaration.parameters_json_schema['required'] == ['value']  # type: ignore[index]


def test_a_cancel_that_adk_ends_quietly_still_cancels_and_rolls_back():
    started = asyncio.Event()
    calls = []

    async def transport(raw):
        message = json.loads(raw)
        calls.append(message['op'])
        if len(calls) == 1:
            return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': {'content': 'first done'}})
        started.set()
        await asyncio.sleep(30)
        return raw

    _bridge.install_transport(transport)

    async def scenario():
        first = LlmAgent(name='first', model=llm('answer'))
        second = LlmAgent(name='second', model=llm('answer'))
        executor = Executor(SequentialAgent(name='root', sub_agents=[first, second]))
        task = asyncio.create_task(executor.run({'prompt': 'one'}, 's1', 5))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert executor._sessions.sessions['galaxie']['galaxie']['s1'].events == []

    asyncio.run(scenario())


def test_a_state_only_final_event_does_not_replace_the_answer():
    def touch(callback_context):
        callback_context.state['touched'] = True

    transport_for([{'content': 'the answer'}])
    assert run(Executor(agent(after_agent_callback=touch))) == 'the answer'


def test_a_non_galaxie_failure_in_the_model_path_cannot_be_swallowed_by_a_callback(monkeypatch):
    def swallow(callback_context, llm_request, error):
        return LlmResponse(content=types.Content(role='model', parts=[types.Part(text='swallowed')]))

    def broken(*args, **kwargs):
        raise RuntimeError('PRIVATE DETAIL')

    monkeypatch.setattr(face, '_messages', broken)
    transport_for([{'content': 'never'}])
    assert code_of(lambda: run(Executor(agent(on_model_error_callback=swallow)))) == 'executor_error'
