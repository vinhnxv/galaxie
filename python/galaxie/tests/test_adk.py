# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import base64
import json
from typing import Any, cast

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


def streaming_transport(rounds, seen=None):
    """Answer each model request with its chunks and then its final reply; a string final is an error code."""
    rounds = iter(rounds)

    async def transport(raw):
        message = json.loads(raw)
        if seen is not None:
            seen.append((message['op'], message['payload']))
        if message['op'] != 'model':
            return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': {'value': 42}})
        chunks, final = next(rounds)
        for chunk in chunks:
            _bridge.receive_model_chunk(json.dumps({**message, 'kind': 'notify', 'op': 'model-chunk', 'payload': chunk}))
            await asyncio.sleep(0)
        if isinstance(final, str):
            return json.dumps({
                'v': message['v'], 'kind': 'response', 'id': message['id'], 'op': 'model',
                'ok': False, 'error': {'code': final},
            })
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': final})

    _bridge.install_transport(transport)


def streamed(executor, steps=5, prompt='question', session='s1'):
    events = []
    output = asyncio.run(executor.run(
        {'prompt': prompt}, session, steps, on_stream=lambda mode, data: events.append((mode, data)),
    ))
    return output, events


def test_streamed_text_arrives_in_order_and_joins_to_the_final_output():
    seen = []
    streaming_transport([([{'content': 'A '}, {'content': 'streamed '}, {'content': 'answer.'}], {'content': 'A streamed answer.'})], seen)
    output, events = streamed(Executor(agent()))
    assert output == 'A streamed answer.'
    assert events == [('messages', {'author': 'root', 'text': text}) for text in ('A ', 'streamed ', 'answer.')]
    assert seen[0][1]['options'] == {'stream': True}


def test_a_run_without_a_stream_callback_does_not_ask_the_provider_to_stream():
    seen = []
    transport_for([{'content': 'plain'}], seen)
    assert run(Executor(agent())) == 'plain'
    assert 'stream' not in seen[0][1]['options']


def test_a_tool_turn_emits_content_free_markers_and_no_call_id_or_argument():
    secret = tool_call('math_double_1', '{"value":777}', 'CANARY_CALL_ID')
    streaming_transport([
        ([{'content': '', 'toolCalls': [{'index': 0, 'id': 'CANARY_CALL_ID', 'function': {'name': 'math_double_1', 'arguments': '{"value":777}'}}]}],
         {'content': '', 'toolCalls': [secret]}),
        ([{'content': 'done'}], {'content': 'done'}),
    ])
    output, events = streamed(Executor(agent([double()])))
    assert output == 'done'
    assert events == [
        ('updates', {'step': 'tool_call', 'tool': 'math_double_1', 'index': 0}),
        ('updates', {'step': 'tool_result', 'tool': 'math_double_1', 'index': 1}),
        ('messages', {'author': 'root', 'text': 'done'}),
    ]
    assert 'CANARY' not in json.dumps(events) and '777' not in json.dumps(events)


def test_a_mid_stream_block_fails_denied_and_earlier_deltas_stay_delivered():
    streaming_transport([([{'content': 'Allowed '}], 'denied')])
    executor = Executor(agent())
    events = []
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'q'}, 's1', 5, on_stream=lambda mode, data: events.append((mode, data))))
    assert error.value.code == 'denied'
    assert events == [('messages', {'author': 'root', 'text': 'Allowed '})]
    assert not _bridge._streams


def test_a_long_delta_is_split_without_splitting_a_surrogate_pair():
    # The emoji straddles the boundary; it is one code point, so it moves whole to a slice.
    text = 'a' * (face.MAX_DELTA - 1) + '\U0001f600' + 'b' * 10
    streaming_transport([([{'content': text}], {'content': text})])
    output, events = streamed(Executor(agent()))
    deltas = [data['text'] for _, data in events]
    assert output == text and ''.join(deltas) == text
    assert [len(delta) for delta in deltas] == [face.MAX_DELTA, 10]
    for delta in deltas:
        delta.encode('utf-8')


def test_a_pair_split_across_two_provider_chunks_is_joined_before_it_is_delivered():
    streaming_transport([([{'content': 'x\ud83d'}, {'content': '\ude00y'}], {'content': 'x\U0001f600y'})])
    output, events = streamed(Executor(agent()))
    assert output == 'x\U0001f600y'
    assert [data['text'] for _, data in events] == ['x', '\U0001f600y']
    for _, data in events:
        data['text'].encode('utf-8')


def test_cancelling_mid_stream_stops_events_drains_the_bridge_and_rolls_back():
    async def transport(raw: str) -> str:
        message = json.loads(raw)
        _bridge.receive_model_chunk(json.dumps({**message, 'kind': 'notify', 'op': 'model-chunk', 'payload': {'content': 'first'}}))
        return await asyncio.Future()

    _bridge.install_transport(transport)
    executor = Executor(agent())
    events = []

    async def go():
        def on_stream(mode, data):
            events.append(data)
            task.cancel()

        task = asyncio.ensure_future(executor.run({'prompt': 'q'}, 's1', 5, on_stream=on_stream))
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)

    asyncio.run(go())
    assert events == [{'author': 'root', 'text': 'first'}]
    assert not _bridge._streams
    assert executor._sessions.sessions['galaxie']['galaxie']['s1'].events == []


def test_a_stream_callback_failure_ends_the_run_with_its_code():
    streaming_transport([([{'content': 'text'}], {'content': 'text'})])

    def fail(mode, data):
        raise GalaxieError('unsupported')

    with pytest.raises(GalaxieError) as error:
        asyncio.run(Executor(agent()).run({'prompt': 'q'}, 's1', 5, on_stream=fail))
    assert error.value.code == 'unsupported'


def test_parallel_agents_keep_their_own_half_pair():
    streaming_transport([
        ([{'content': 'x\ud83d'}, {'content': '\ude00'}], {'content': 'x\U0001f600'}),
        ([{'content': 'y'}, {'content': 'z'}], {'content': 'yz'}),
    ])
    first = LlmAgent(name='first', model=llm('answer'), instruction='a')
    second = LlmAgent(name='second', model=llm('answer'), instruction='b')
    _, events = streamed(Executor(ParallelAgent(name='root', sub_agents=[first, second])))
    texts = {}
    for _, data in events:
        data['text'].encode('utf-8')
        texts[data['author']] = texts.get(data['author'], '') + data['text']
    assert sorted(texts.values()) == ['x\U0001f600', 'yz']


def interact(requests):
    return {
        'surfaceId': 'main', 'viewRevision': 'r1', 'component': 'app.Approval/v1',
        'props': {'requests': requests},
    }


def gated(**options):
    return capability_tool('math.double@1', 'math.double@1', PARAMETERS, 'Double an integer.', require_confirmation=True, **options)


def pausing(tools, **hooks):
    hooks.setdefault('interaction', interact)
    return Executor(agent(tools), **hooks)


def answer(executor, interaction, action='approve', payload=None, steps=5, session='s1'):
    resume = {'interactionId': interaction['id'], 'action': action, 'payload': {'indexes': [0]} if payload is None else payload}
    return asyncio.run(executor.run(None, session, steps, resume=resume))


def test_a_confirmation_pauses_with_one_interaction_and_runs_no_tool():
    seen = []
    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}', 'CANARY_CALL_ID')]}], seen)
    executor = pausing([gated()])
    assert run(executor) is None
    assert [op for op, _ in seen] == ['model']
    pending = executor.pending('s1')
    assert pending is not None and set(pending) == {'id', 'value'}
    assert pending['value']['props'] == {'requests': [{'kind': 'confirmation', 'tool': 'math_double_1', 'args': {'value': 21}}]}
    assert 'CANARY' not in json.dumps(pending) and 'adk-' not in json.dumps(pending)
    assert executor.pending('other') is None


def test_approve_runs_the_tool_once_and_completes():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}')]},
        {'value': 42}, {'content': 'done'},
    ], seen)
    executor = pausing([gated()])
    run(executor)
    pending = executor.pending('s1')
    assert pending is not None
    assert answer(executor, pending) == 'done'
    assert [op for op, _ in seen] == ['model', 'capability', 'model']
    assert seen[1][1]['input'] == {'value': 21}
    assert seen[2][1]['messages'][-1] == {'role': 'tool', 'tool_call_id': 'galaxie-1', 'content': '{"value":42}'}
    assert executor.pending('s1') is None


def test_deny_reports_the_denial_to_the_model_and_completes():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}')]}, {'content': 'declined'},
    ], seen)
    executor = pausing([gated()])
    run(executor)
    pending = executor.pending('s1')
    assert pending is not None
    assert answer(executor, pending, 'deny') == 'declined'
    assert [op for op, _ in seen] == ['model', 'model']
    assert json.loads(seen[1][1]['messages'][-1]['content']) == {'error': 'This tool call is rejected.'}


def two_calls():
    return {'content': '', 'toolCalls': [
        tool_call('math_double_1', '{"value":1}', 'call_a'), tool_call('math_double_1', '{"value":2}', 'call_b'),
    ]}


def test_two_confirmations_in_one_response_form_one_interaction_the_default_resume_covers_both():
    seen = []
    transport_for([two_calls(), {'value': 2}, {'value': 4}, {'content': 'both'}], seen)
    executor = pausing([gated()])
    run(executor)
    pending = executor.pending('s1')
    assert pending is not None
    assert [item['args'] for item in pending['value']['props']['requests']] == [{'value': 1}, {'value': 2}]
    assert answer(executor, pending, payload={'indexes': [1, 0]}) == 'both'
    assert [op for op, _ in seen] == ['model', 'capability', 'capability', 'model']


@pytest.mark.parametrize('action,payload', [
    ('approve', {'indexes': [0]}), ('approve', {'indexes': [0, 0]}), ('approve', {'indexes': [0, 2]}),
    ('approve', {'indexes': [0, True]}), ('approve', {'indexes': [0, 1], 'extra': 1}), ('approve', {}),
    ('approve', None), ('maybe', {'indexes': [0, 1]}),
])
def test_a_default_resume_that_does_not_cover_every_request_once_fails_invalid_and_runs_nothing(action, payload):
    seen = []
    transport_for([two_calls(), {'value': 2}, {'value': 4}, {'content': 'both'}], seen)
    executor = pausing([gated()])
    run(executor)
    pending = executor.pending('s1')
    assert pending is not None
    assert code_of(lambda: answer(executor, pending, action, payload)) == 'invalid'
    assert [op for op, _ in seen] == ['model']
    assert executor.pending('s1') == pending
    assert answer(executor, pending, payload={'indexes': [0, 1]}) == 'both'


def test_a_long_running_tool_pauses_after_its_pending_result_and_the_payload_supplies_the_answer():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":5}')]},
        {'status': 'started'}, {'content': 'finished'},
    ], seen)

    def resume(requests, action, payload):
        assert [request['kind'] for request in requests] == ['long-running'] and action == 'submit'
        return [{'response': payload}]

    long = capability_tool('math.double@1', 'math.double@1', PARAMETERS, 'Start a job.', long_running=True)
    executor = pausing([long], resume=resume)
    assert run(executor) is None
    assert [op for op, _ in seen] == ['model', 'capability']
    pending = executor.pending('s1')
    assert pending is not None
    assert pending['value']['props']['requests'] == [{'kind': 'long-running', 'tool': 'math_double_1', 'args': {'value': 5}}]
    assert answer(executor, pending, 'submit', {'result': 'external'}) == 'finished'
    assert [op for op, _ in seen] == ['model', 'capability', 'model']
    tool_messages = [message for message in seen[2][1]['messages'] if message['role'] == 'tool']
    assert [json.loads(message['content']) for message in tool_messages] == [{'result': 'external'}]


def test_the_default_resume_does_not_answer_a_long_running_call():
    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":5}')]}, {'status': 'started'}])
    long = capability_tool('math.double@1', 'math.double@1', PARAMETERS, 'Start a job.', long_running=True)
    executor = pausing([long])
    run(executor)
    pending = executor.pending('s1')
    assert pending is not None
    assert code_of(lambda: answer(executor, pending)) == 'invalid'
    assert executor.pending('s1') == pending


def test_a_wrong_interaction_id_fails_stale_before_any_tool_runs_and_the_pause_stays_answerable():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}')]}, {'value': 42}, {'content': 'done'},
    ], seen)
    executor = pausing([gated()])
    run(executor)
    pending = executor.pending('s1')
    assert pending is not None
    assert code_of(lambda: answer(executor, {'id': 'f' * 64})) == 'stale'
    assert code_of(lambda: answer(executor, pending, session='other')) == 'stale'
    assert [op for op, _ in seen] == ['model']
    assert answer(executor, pending) == 'done'
    assert code_of(lambda: answer(executor, pending)) == 'stale'


def test_a_malformed_resume_fails_invalid_before_any_tool_runs():
    seen = []
    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}')]}], seen)
    executor = pausing([gated()])
    run(executor)
    pending = executor.pending('s1')
    assert pending is not None
    for resume in (
        {'interactionId': pending['id'], 'action': 'approve'},
        {'interactionId': pending['id'], 'action': 3, 'payload': {'indexes': [0]}},
        {'interactionId': pending['id'], 'action': 'approve', 'payload': {'indexes': [0]}, 'extra': 1},
    ):
        assert code_of(lambda: asyncio.run(executor.run(None, 's1', 5, resume=resume))) == 'invalid'
    assert [op for op, _ in seen] == ['model']


@pytest.mark.parametrize('decisions', [
    [], [{'confirmed': True}, {'confirmed': True}], [{'confirmed': 'yes'}], [{'response': {}}],
    [{'confirmed': True, 'extra': 1}], 'approve', [None],
])
def test_an_author_resume_whose_answer_does_not_match_the_requests_fails_invalid_before_any_tool_runs(decisions):
    seen = []
    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}')]}], seen)
    executor = pausing([gated()], resume=lambda requests, action, payload: decisions)
    run(executor)
    pending = executor.pending('s1')
    assert pending is not None
    assert code_of(lambda: answer(executor, pending)) == 'invalid'
    assert [op for op, _ in seen] == ['model']


def test_an_author_resume_that_raises_fails_invalid():
    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}')]}])

    def resume(requests, action, payload):
        raise RuntimeError('secret detail')

    executor = pausing([gated()], resume=resume)
    run(executor)
    pending = executor.pending('s1')
    assert pending is not None
    assert code_of(lambda: answer(executor, pending)) == 'invalid'


def test_scripted_calls_reusing_one_id_get_distinct_interaction_ids_per_pause():
    transport_for([
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":1}', 'same')]}, {'value': 2},
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":2}', 'same')]}, {'value': 4},
        {'content': 'done'},
    ])
    executor = pausing([gated()])
    run(executor)
    first = executor.pending('s1')
    assert first is not None
    assert answer(executor, first) is None
    second = executor.pending('s1')
    assert second is not None and second['id'] != first['id']
    assert code_of(lambda: answer(executor, first)) == 'stale'
    assert answer(executor, second) == 'done'


def test_a_pausing_tool_without_an_interaction_hook_is_refused_before_any_run():
    assert code_of(lambda: Executor(agent([gated()]))) == 'unsupported'
    assert code_of(lambda: prepare_executor(agent([gated()]))) == 'unsupported'
    Executor(agent([double()]))


def test_an_interaction_hook_that_fails_or_returns_a_bad_request_fails_unsupported_and_rolls_back():
    def divide(requests: list[dict[str, Any]]) -> dict[str, Any]:
        return {'surfaceId': 1 / 0}

    for hook in (lambda requests: {'surfaceId': 'main'}, divide):
        transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}')]}])
        executor = Executor(agent([gated()]), interaction=hook)
        assert code_of(lambda: run(executor)) == 'unsupported'
        assert executor.pending('s1') is None
        assert executor._sessions.sessions['galaxie']['galaxie']['s1'].events == []


def test_a_new_prompt_while_a_pause_is_pending_fails_invalid():
    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}')]}])
    executor = pausing([gated()])
    run(executor)
    pending = executor.pending('s1')
    assert code_of(lambda: run(executor, prompt='again')) == 'invalid'
    assert executor.pending('s1') == pending


def test_a_failed_resume_keeps_the_pause_and_a_retry_completes():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}')]}, {'value': 42}, 'unavailable',
        {'value': 42}, {'content': 'done'},
    ], seen)
    executor = pausing([gated()])
    run(executor)
    pending = executor.pending('s1')
    assert pending is not None
    assert code_of(lambda: answer(executor, pending)) == 'unavailable'
    assert executor.pending('s1') == pending
    assert answer(executor, pending) == 'done'


def test_a_confirmation_beside_an_ordinary_call_runs_the_ordinary_call_once_before_the_pause():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [
            tool_call('math_double_1', '{"value":1}', 'call_a'), tool_call('math_double_2', '{"value":2}', 'call_b'),
        ]},
        {'value': 4}, {'value': 2}, {'content': 'both'},
    ], seen)
    plain = capability_tool('math.double@2', 'math.double@2', PARAMETERS, 'Plain.')
    executor = pausing([gated(), plain])
    run(executor)
    assert [op for op, _ in seen] == ['model', 'capability']
    assert seen[1][1]['name'] == 'math.double@2'
    pending = executor.pending('s1')
    assert pending is not None
    assert [item['tool'] for item in pending['value']['props']['requests']] == ['math_double_1']
    assert answer(executor, pending) == 'both'
    assert [payload['name'] for op, payload in seen if op == 'capability'] == ['math.double@2', 'math.double@1']
    assert sorted(message['tool_call_id'] for message in seen[-1][1]['messages'] if message['role'] == 'tool') == ['galaxie-1', 'galaxie-2']


def test_a_confirmation_beside_a_long_running_call_fails_unsupported_before_any_capability_runs():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [
            tool_call('math_double_1', '{"value":1}', 'call_a'), tool_call('math_double_2', '{"value":2}', 'call_b'),
        ]},
    ], seen)
    long = capability_tool('math.double@2', 'math.double@2', PARAMETERS, 'Start a job.', long_running=True)
    executor = pausing([gated(), long])
    assert code_of(lambda: run(executor)) == 'unsupported'
    assert [op for op, _ in seen] == ['model']
    assert executor.pending('s1') is None
    assert executor._sessions.sessions['galaxie']['galaxie']['s1'].events == []


def test_a_failing_paused_marker_rolls_the_run_back_and_publishes_no_pause():
    streaming_transport([
        ([{'content': '', 'toolCalls': [{'index': 0, 'id': 'x', 'function': {'name': 'math_double_1', 'arguments': '{"value":1}'}}]}],
         {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":1}', 'x')]}),
    ])
    executor = pausing([gated()])

    def fail_on_pause(mode, data):
        if data.get('step') == 'paused':
            raise GalaxieError('unavailable')

    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'q'}, 's1', 5, on_stream=fail_on_pause))
    assert error.value.code == 'unavailable'
    assert executor.pending('s1') is None
    assert executor._sessions.sessions['galaxie']['galaxie']['s1'].events == []


def test_a_resume_that_is_not_an_object_fails_invalid():
    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}')]}])
    executor = pausing([gated()])
    run(executor)
    for resume in ('approve', 3, ['x']):
        assert code_of(lambda: asyncio.run(executor.run(None, 's1', 5, resume=cast(Any, resume)))) == 'invalid'
    assert executor.pending('s1') is not None


def test_the_stream_marks_a_pause_without_the_confirmation_call_or_any_content():
    streaming_transport([
        ([{'content': '', 'toolCalls': [{'index': 0, 'id': 'CANARY_CALL_ID', 'function': {'name': 'math_double_1', 'arguments': '{"value":777}'}}]}],
         {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":777}', 'CANARY_CALL_ID')]}),
    ])
    output, events = streamed(pausing([gated()]))
    assert output is None
    assert events == [
        ('updates', {'step': 'tool_call', 'tool': 'math_double_1', 'index': 0}),
        ('updates', {'step': 'tool_result', 'tool': 'math_double_1', 'index': 1}),
        ('updates', {'step': 'paused', 'tool': 'math_double_1', 'index': 2}),
    ]
    assert 'CANARY' not in json.dumps(events) and '777' not in json.dumps(events)


def test_an_option_that_is_not_a_boolean_or_asks_for_both_pauses_fails_invalid():
    cases: list[dict[str, Any]] = [
        {'require_confirmation': 'yes'}, {'long_running': 1}, {'require_confirmation': True, 'long_running': True},
    ]
    for options in cases:
        assert code_of(lambda: capability_tool('t', 'math.double@1', PARAMETERS, 'd', **options)) == 'invalid'


def named(name, tool):
    return LlmAgent(name=name, model=llm('answer'), instruction='x', tools=[tool])


def quiet_child(name='quiet'):
    return LlmAgent(name=name, model=llm('answer'), instruction='x')


@pytest.mark.parametrize('build', [
    lambda: SequentialAgent(name='root', sub_agents=[named('a', gated()), quiet_child()]),
    lambda: ParallelAgent(name='root', sub_agents=[named('a', gated()), quiet_child()]),
    lambda: LoopAgent(name='root', sub_agents=[named('a', gated())], max_iterations=2),
    lambda: LlmAgent(name='root', model=llm('answer'), instruction='x', tools=[gated()], sub_agents=[quiet_child()]),
    lambda: LlmAgent(name='root', model=llm('answer'), instruction='x', sub_agents=[named('a', gated())]),
    lambda: SequentialAgent(name='root', sub_agents=[
        SequentialAgent(name='inner', sub_agents=[named('a', gated()), quiet_child('b')]), quiet_child('c'),
    ]),
    lambda: SequentialAgent(name='root', sub_agents=[quiet_child('a'), named('a', gated())]),
])
def test_a_pausing_agent_that_is_not_the_last_to_run_or_has_a_duplicate_name_fails_unsupported(build):
    assert code_of(lambda: Executor(build())) == 'unsupported'


def test_a_pausing_agent_in_the_last_position_is_accepted_and_others_are_unaffected():
    Executor(SequentialAgent(name='root', sub_agents=[
        quiet_child(), SequentialAgent(name='inner', sub_agents=[quiet_child('b'), named('last', gated())]),
    ]), interaction=interact)
    Executor(ParallelAgent(name='root', sub_agents=[named('a', double()), quiet_child()]))


def test_a_pause_in_the_last_child_of_a_sequence_resumes_that_child():
    seen = []
    transport_for([
        {'content': 'first done'},
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}')]}, {'value': 42}, {'content': 'last done'},
    ], seen)
    first = LlmAgent(name='first', model=llm('answer'), instruction='x')
    executor = Executor(SequentialAgent(name='root', sub_agents=[first, named('last', gated())]), interaction=interact)
    assert run(executor) is None
    pending = executor.pending('s1')
    assert pending is not None
    assert answer(executor, pending) == 'last done'
    assert [op for op, _ in seen] == ['model', 'model', 'capability', 'model']


def durable(executor):
    executor.durable = True
    return executor


def stored(executor, session='s1', binding='bound'):
    return executor._snapshot(session, binding)


def restored(checkpoint, metadata, binding='bound', **hooks):
    executor = durable(pausing([gated()], **hooks))
    return executor, asyncio.run(executor._restore(checkpoint, metadata, binding))


def edit(raw, change):
    value = json.loads(raw)
    change(value)
    return json.dumps(value, separators=(',', ':')).encode()


def paused_record(**hooks):
    seen = []
    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}')]}], seen)
    executor = durable(pausing([gated()], **hooks))
    assert run(executor) is None
    return executor, stored(executor)


def test_a_completed_session_restores_into_a_new_executor_and_keeps_its_history():
    seen = []
    transport_for([{'content': 'first'}, {'content': 'second'}], seen)
    original = durable(Executor(agent()))
    assert run(original, prompt='one') == 'first'
    checkpoint, metadata = stored(original)
    other = durable(Executor(agent()))
    conversation = asyncio.run(other._restore(checkpoint, metadata, 'bound'))
    assert conversation == 's1'
    assert other.pending(conversation) is None
    assert run(other, prompt='two') == 'second'
    roles = [(message['role'], message['content']) for message in seen[-1][1]['messages'] if message['role'] != 'system']
    assert roles == [('user', 'one'), ('assistant', 'first'), ('user', 'two')]


def test_a_pause_restores_with_the_same_interaction_and_never_asks_the_author_hook_again():
    original, (checkpoint, metadata) = paused_record()
    asked = []

    def hook(requests):
        asked.append(requests)
        return interact(requests)

    other, conversation = restored(checkpoint, metadata, interaction=hook)
    assert asked == []
    assert other.pending(conversation) == original.pending('s1')
    transport_for([{'value': 42}, {'content': 'done'}])
    assert answer(other, other.pending(conversation)) == 'done'
    assert other.pending(conversation) is None


def test_a_restored_pause_stays_answerable_after_a_second_snapshot_and_restore():
    _, (checkpoint, metadata) = paused_record()
    middle, conversation = restored(checkpoint, metadata)
    again, _ = restored(*stored(middle))
    transport_for([{'value': 42}, {'content': 'done'}])
    assert answer(again, again.pending(conversation)) == 'done'


def test_the_interaction_id_covers_the_request_content():
    first, _ = paused_record()
    second, _ = paused_record(interaction=lambda requests: {**interact(requests), 'viewRevision': 'r2'})
    other_args = durable(pausing([gated()]))
    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":22}')]}])
    assert run(other_args) is None
    ids = {(executor.pending('s1') or {})['id'] for executor in (first, second, other_args)}
    assert len(ids) == 3


def test_the_record_never_holds_the_key_in_the_checkpoint_and_the_key_is_per_session():
    _, (checkpoint, metadata) = paused_record()
    key = json.loads(metadata)['key']
    assert key not in checkpoint.decode()
    _, (checkpoint2, metadata2) = paused_record()
    assert json.loads(metadata2)['key'] != key


@pytest.mark.parametrize('change', [
    lambda value: value['events'][1]['content']['parts'][0]['functionCall']['args'].update(value=22),
    lambda value: value['events'][2]['content']['parts'][0]['functionCall']['args']['originalFunctionCall']['args'].update(value=22),
    lambda value: value['events'][2]['content']['parts'][0]['functionCall'].update(name='adk_request_input'),
    lambda value: value['events'][1]['customMetadata'].clear(),
    lambda value: value['events'].pop(2),
    lambda value: value['events'][3]['content']['parts'][0]['functionResponse'].update(id=value['events'][2]['content']['parts'][0]['functionCall']['id']),
    lambda value: value['events'].append(value['events'][0]),
    lambda value: value['events'][0].update(partial=True),
    lambda value: value.update(extra=1),
    lambda value: value.update(v=2),
    lambda value: value.update(conversation_id=''),
    lambda value: value.update(events={}),
])
def test_a_changed_event_log_is_unrecoverable(change):
    _, (checkpoint, metadata) = paused_record()
    assert code_of(lambda: restored(edit(checkpoint, change), metadata)) == 'unrecoverable'


@pytest.mark.parametrize('change', [
    lambda value: value.update(key='AAAA'),
    lambda value: value.update(key=value['key'][:-2] + 'AA'),
    lambda value: value.update(session='other'),
    lambda value: value.update(pauses=0),
    lambda value: value.update(pauses=-1),
    lambda value: value.update(extra=1),
    lambda value: value.pop('pending') and None,
    lambda value: value['pending'].update(extra=1),
    lambda value: value['pending']['asks'][0].update(args={'value': 22}),
    lambda value: value['pending']['asks'][0].update(call='unknown'),
    lambda value: value['pending']['interaction'].update(id='forged'),
    lambda value: value['pending']['interaction']['value']['props']['requests'][0].update(tool='other'),
])
def test_changed_metadata_is_unrecoverable(change):
    _, (checkpoint, metadata) = paused_record()
    assert code_of(lambda: restored(checkpoint, edit(metadata, change))) == 'unrecoverable'


def test_non_json_and_non_utf8_records_are_unrecoverable():
    _, (checkpoint, metadata) = paused_record()
    for bad in (b'not json', b'\xff\xfe', b'[]', b'null'):
        assert code_of(lambda: restored(bad, metadata)) == 'unrecoverable'
        assert code_of(lambda: restored(checkpoint, bad)) == 'unrecoverable'


def test_a_forged_tool_call_with_a_copied_stamp_is_refused_by_the_session_key():
    _, (checkpoint, metadata) = paused_record()
    other, (checkpoint_two, metadata_two) = paused_record()
    # Events from another session carry stamps made with another key.
    assert code_of(lambda: restored(checkpoint_two, metadata)) == 'unrecoverable'


def test_a_restore_that_fails_leaves_the_executor_unchanged():
    original, (checkpoint, metadata) = paused_record()
    before = original.pending('s1')
    assert code_of(lambda: asyncio.run(original._restore(checkpoint, edit(metadata, lambda v: v.update(key='AAAA')), 'bound'))) == 'unrecoverable'
    assert original.pending('s1') == before


def test_a_failed_run_writes_nothing_and_a_snapshot_of_a_rolled_back_run_is_the_earlier_one():
    transport_for([{'content': 'first'}, 'unavailable'])
    executor = durable(Executor(agent()))
    assert run(executor, prompt='one') == 'first'
    before = stored(executor)
    assert code_of(lambda: run(executor, prompt='two')) == 'unavailable'
    assert stored(executor) == before


def test_a_session_that_was_never_run_cannot_be_snapshotted():
    assert code_of(lambda: durable(Executor(agent()))._snapshot('none')) == 'unrecoverable'


def test_snapshot_without_a_binding_omits_it_and_restore_without_a_binding_accepts_that():
    transport_for([{'content': 'ok'}])
    executor = durable(Executor(agent()))
    run(executor)
    checkpoint, metadata = executor._snapshot('s1')
    assert 'session' not in json.loads(metadata)
    other = durable(Executor(agent()))
    assert asyncio.run(other._restore(checkpoint, metadata)) == 's1'


def test_a_non_durable_executor_has_no_frame_limit():
    transport_for([{'content': 'x' * 900000}])
    executor = Executor(agent())
    assert run(executor) == 'x' * 900000


def test_a_reply_that_crosses_the_frame_limit_fails_unsupported_and_rolls_back():
    transport_for([{'content': 'ok'}, {'content': 'x' * (face.RECORD_LIMIT + 1)}, {'content': 'again'}])
    executor = durable(Executor(agent()))
    assert run(executor, prompt='one') == 'ok'
    before = stored(executor)
    assert code_of(lambda: run(executor, prompt='two')) == 'unsupported'
    assert stored(executor) == before
    assert run(executor, prompt='three') == 'again'


def test_a_tool_result_that_crosses_the_limit_fails_before_the_next_model_dispatch():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":1}')]},
        {'value': 'x' * face.RECORD_LIMIT},
        {'content': 'never'},
    ], seen)
    executor = durable(Executor(agent([double()])))
    assert code_of(lambda: run(executor)) == 'unsupported'
    assert [op for op, _ in seen] == ['model', 'capability']


def test_the_final_answer_keeps_its_reserve_and_a_run_that_starts_inside_the_margin_is_refused():
    fits = face.RECORD_LIMIT - 8000
    transport_for([{'content': 'x' * fits}])
    executor = durable(Executor(agent()))
    assert run(executor, prompt='a') == 'x' * fits
    checkpoint, metadata = stored(executor)
    assert len(checkpoint) <= face.RECORD_LIMIT
    other = durable(Executor(agent()))
    asyncio.run(other._restore(checkpoint, metadata, 'bound'))
    transport_for([{'content': 'more'}])
    assert code_of(lambda: run(other, prompt='b')) == 'unsupported'


def test_the_largest_permitted_record_fits_one_bridge_frame_and_round_trips():
    fits = face.RECORD_LIMIT - 3000
    transport_for([{'content': 'x' * fits}])
    executor = durable(Executor(agent()))
    run(executor)
    checkpoint, metadata = stored(executor)
    frame = json.dumps({'checkpoint': base64.b64encode(checkpoint).decode(), 'metadata': base64.b64encode(metadata).decode()})
    assert len(frame.encode()) < _bridge.MAX_BYTES
    other = durable(Executor(agent()))
    assert asyncio.run(other._restore(checkpoint, metadata, 'bound')) == 's1'


def test_binary_parts_are_refused_when_stored():
    event = face.Event(author='root', content=types.Content(role='model', parts=[types.Part(inline_data=types.Blob(data=b'x', mime_type='image/png'))]))
    assert face._binary(event)
    assert not face._binary(face.Event(author='root', content=types.Content(role='model', parts=[types.Part(text='a')])))


def test_a_long_running_pause_restores_and_the_author_resume_still_answers_it():
    hooks = {'interaction': interact, 'resume': lambda requests, action, payload: [{'response': payload} for _ in requests]}

    def build():
        tool = capability_tool('math.double@1', 'math.double@1', PARAMETERS, 'Double an integer.', long_running=True)
        return durable(Executor(agent([tool]), **hooks))

    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":3}')]}, {'value': 6}])
    original = build()
    assert run(original) is None
    checkpoint, metadata = stored(original)
    other = build()
    conversation = asyncio.run(other._restore(checkpoint, metadata, 'bound'))
    assert other.pending(conversation) == original.pending('s1')
    transport_for([{'content': 'done'}])
    resume = {'interactionId': (other.pending(conversation) or {})['id'], 'action': 'submit', 'payload': {'result': 'six'}}
    assert asyncio.run(other.run(None, conversation, 5, resume=resume)) == 'done'


def test_a_restored_session_continues_the_call_numbering_without_colliding():
    seen = []
    transport_for([
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":1}')]}, {'value': 2}, {'content': 'one'},
        {'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":2}')]}, {'value': 4}, {'content': 'two'},
    ], seen)
    original = durable(Executor(agent([double()])))
    assert run(original, prompt='first') == 'one'
    other = durable(Executor(agent([double()])))
    asyncio.run(other._restore(*stored(original), 'bound'))
    assert run(other, prompt='second') == 'two'
    scopes = [payload['effectScope'] for op, payload in seen if op == 'capability']
    assert scopes == ['adk-python/s1/root/0/0', 'adk-python/s1/root/1/0']
    assert 'galaxie-2' in json.dumps(seen[-1][1])


def test_an_event_marked_restored_cannot_hide_a_changed_call():
    executor, (checkpoint, metadata) = paused_record()

    def mark(value):
        for event in value['events']:
            event['customMetadata'] = {**(event.get('customMetadata') or {}), '__adk_internal_restored_event': True}
            for part in (event.get('content') or {}).get('parts') or []:
                if part.get('functionCall', {}).get('name') == 'double':
                    part['functionCall']['args']['value'] = 99

    assert code_of(lambda: restored(edit(checkpoint, mark), metadata)) == 'unrecoverable'


def test_a_restore_refuses_a_conversation_another_session_holds_before_installing_anything():
    executor, (checkpoint, metadata) = paused_record()
    other = durable(pausing([gated()]))
    conversation = json.loads(checkpoint)['conversation_id']
    assert code_of(lambda: asyncio.run(other._restore(checkpoint, metadata, 'bound', [conversation]))) == 'unrecoverable'
    assert other.pending(conversation) is None
    assert conversation not in other._sessions.sessions.get('galaxie', {}).get('galaxie', {})


def test_a_pause_with_a_request_too_large_to_echo_is_refused_before_it_is_published():
    transport_for([{'content': '', 'toolCalls': [tool_call('math_double_1', '{"value":21}')]}])
    executor = durable(pausing([gated()], interaction=lambda requests: {**interact(requests), 'props': {'note': 'x' * 20000}}))
    with pytest.raises(GalaxieError) as error:
        run(executor)
    assert error.value.code == 'unsupported'
    assert executor.pending('s1') is None


def test_a_session_id_that_cannot_fit_the_frame_is_refused_at_snapshot():
    transport_for([{'content': 'hello'}])
    executor = durable(Executor(agent()))
    assert run(executor, session='s' * 400000) == 'hello'
    assert code_of(lambda: executor._snapshot('s' * 400000, 'q' * 200000)) == 'unsupported'
