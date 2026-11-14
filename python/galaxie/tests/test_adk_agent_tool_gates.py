# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Scripted measurements of the isolated AgentTool candidate's boundaries."""

import asyncio
import json
from collections import Counter

import pytest
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import AgentTool, FunctionTool
from google.genai import types
from pydantic import BaseModel

from galaxie import GalaxieError, _bridge
from galaxie import adk as face
from galaxie.adk import Executor, agent_tool, capability_tool, llm, loop_exit, toolset


PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}
STATE_INSTRUCTION = 'ordinary={ordinary?}; temporary={temp:input?}; private={_adk:private?}'


def leaf(name='inner', **options):
    return LlmAgent(name=name, model=llm(name), **options)


def read_tool(name='read'):
    return capability_tool(name, 'notes.read@1', PARAMETERS, 'Read an integer.')


def call(name='inner', arguments='{"request":"question"}'):
    return {'content': '', 'toolCalls': [{
        'id': 'provider', 'type': 'function', 'function': {'name': name, 'arguments': arguments},
    }]}


def script(replies, seen=None):
    responses = iter(replies)

    async def transport(raw):
        message = json.loads(raw)
        if seen is not None:
            seen.append((message['op'], message['payload']))
        reply = next(responses)
        if isinstance(reply, str):
            return json.dumps({'v': message['v'], 'kind': 'response', 'id': message['id'], 'op': message['op'],
                               'ok': False, 'error': {'code': reply}})
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})

    _bridge.install_transport(transport)


def run(executor, *, steps=10, prompt='go', stream=None):
    return asyncio.run(executor.run({'prompt': prompt}, 's', steps, on_stream=stream))


def stored(executor):
    return executor._snapshot('s', 'bound')


def events(executor):
    return executor._sessions.sessions['galaxie']['galaxie']['s'].events


def root(*, inner_tools=(), outer_tools=(), output_key=None):
    return leaf('outer', tools=[agent_tool(leaf(tools=list(inner_tools), output_key=output_key)), *outer_tools])


def code_of(action):
    with pytest.raises(GalaxieError) as error:
        action()
    return error.value.code


@pytest.mark.parametrize('output_key', ['changed', 'temp:changed'])
def test_declaration_result_copied_state_and_forwarded_delta_equal_native(output_key):
    native_requests = []
    turns = Counter()

    class Scripted(BaseLlm):
        async def generate_content_async(self, llm_request, stream=False):
            native_requests.append((self.model, llm_request.model_copy(deep=True)))
            turns[self.model] += 1
            if self.model == 'outer' and turns[self.model] == 1:
                parts = [types.Part(function_call=types.FunctionCall(name='inner', args={'request': 'question'}))]
            else:
                parts = [types.Part(text=f'{self.model} answer')]
            yield LlmResponse(content=types.Content(role='model', parts=parts), turn_complete=True)

    native_inner = LlmAgent(name='inner', model=Scripted(model='inner'), description='Answer one question.',
                            instruction=STATE_INSTRUCTION, output_key=output_key)
    native_tool = AgentTool(native_inner)
    native_outer = LlmAgent(name='outer', model=Scripted(model='outer'), tools=[native_tool])

    async def native():
        sessions = InMemorySessionService()
        session = await sessions.create_session(app_name='native', user_id='user', session_id='s',
                                               state={'ordinary': 'copied', 'temp:input': 'temporary', '_adk:private': 'hidden'})
        runner = Runner(app_name='native', agent=native_outer, session_service=sessions)
        result = [event async for event in runner.run_async(user_id='user', session_id='s',
                  new_message=types.Content(role='user', parts=[types.Part(text='go')]))]
        saved = await sessions.get_session(app_name='native', user_id='user', session_id='s')
        await runner.close()
        assert saved is not None
        return result, saved.state

    native_events, native_state = asyncio.run(native())
    candidate_tool = agent_tool(leaf(description='Answer one question.', instruction=STATE_INSTRUCTION,
                                     output_key=output_key))
    assert candidate_tool._get_declaration() == native_tool._get_declaration()
    executor = Executor(leaf('outer', tools=[candidate_tool]))
    seen = []
    script([call(), {'content': 'inner answer'}, {'content': 'outer answer'}], seen)
    asyncio.run(executor._sessions.create_session(app_name='galaxie', user_id='galaxie', session_id='s',
                state={'ordinary': 'copied', 'temp:input': 'temporary', '_adk:private': 'hidden'}))
    assert run(executor) == 'outer answer'
    assert [payload['role'] for op, payload in seen if op == 'model'] == [name for name, _ in native_requests]
    native_instruction = str(native_requests[1][1].config.system_instruction)
    candidate_instruction = seen[1][1]['messages'][0]['content']
    expected_state = 'ordinary=copied; temporary=; private='
    assert expected_state in native_instruction
    assert expected_state in candidate_instruction
    native_results = [part.function_response.response for event in native_events if event.content
                      for part in event.content.parts or [] if part.function_response]
    candidate_results = [part.function_response.response for event in events(executor) if event.content
                         for part in event.content.parts or [] if part.function_response]
    assert candidate_results == native_results == [{'result': 'inner answer'}]
    assert executor._sessions.sessions['galaxie']['galaxie']['s'].state == native_state
    native_deltas = [event.actions.state_delta for event in native_events if event.content and any(
        part.function_response for part in event.content.parts or [])]
    candidate_deltas = [event.actions.state_delta for event in events(executor) if event.content and any(
        part.function_response for part in event.content.parts or [])]
    assert candidate_deltas == native_deltas


def test_inner_model_calls_spend_the_same_step_budget_as_outer_calls():
    seen = []
    script([call(), {'content': 'inner answer'}, {'content': 'must not dispatch'}], seen)
    executor = Executor(root())
    assert code_of(lambda: run(executor, steps=2)) == 'budget_exceeded'
    assert [payload['role'] for _, payload in seen] == ['outer', 'inner']
    assert events(executor) == []


def test_two_calls_use_distinct_session_stores_and_keys_without_outer_stream_or_record_leak(monkeypatch):
    sessions = []
    keys = []
    original_sessions = face.InMemorySessionService
    original_plugin = face.ToolCallIntegrityPlugin

    class ObservedSessions(original_sessions):
        def __init__(self):
            super().__init__()
            sessions.append(self)

    class ObservedPlugin(original_plugin):
        def __init__(self, *, secret_key):
            super().__init__(secret_key=secret_key)
            keys.append(secret_key)

    monkeypatch.setattr(face, 'InMemorySessionService', ObservedSessions)
    monkeypatch.setattr(face, 'ToolCallIntegrityPlugin', ObservedPlugin)
    twice = call()
    twice['toolCalls'].append({**twice['toolCalls'][0], 'id': 'second'})
    seen = []
    script([twice, {'content': 'inner answer'}, {'content': 'inner answer'}, {'content': 'outer answer'}], seen)
    executor = Executor(root())
    stream = []
    assert run(executor, stream=lambda mode, value: stream.append((mode, value))) == 'outer answer'
    assert len(sessions) == 2 and sessions[0] is not sessions[1]
    assert len(keys) == 3 and len(set(keys)) == 3
    assert [payload['role'] for _, payload in seen] == ['outer', 'inner', 'inner', 'outer']
    assert {event.author for event in events(executor)} == {'user', 'outer'}
    assert [part.function_call.id for event in events(executor) if event.content
            for part in event.content.parts or [] if part.function_call] == ['galaxie-1', 'galaxie-2']
    assert all(value.get('author') != 'inner' for _, value in stream)
    checkpoint, _ = stored(executor)
    assert {event['author'] for event in json.loads(checkpoint)['events']} == {'user', 'outer'}
    assert all(payload['options'].get('stream') is not True for _, payload in seen if payload['role'] == 'inner')


@pytest.mark.parametrize('reload', [False, True])
def test_gap_ids_and_inner_effect_scopes_stay_unique_after_a_completed_turn(reload):
    def build():
        executor = Executor(root(inner_tools=[read_tool()], outer_tools=[read_tool('outside')]))
        executor.durable = True
        return executor

    seen = []
    script([call(), call('read', '{"value":1}'), {'value': 2}, {'content': 'inner answer'},
            call('outside', '{"value":2}'), {'value': 4}, {'content': 'first'},
            call('outside', '{"value":3}'), {'value': 6}, {'content': 'second'}], seen)
    executor = build()
    assert run(executor) == 'first'
    first_ids = [part.function_call.id for event in events(executor) if event.content
                 for part in event.content.parts or [] if part.function_call]
    assert first_ids == ['galaxie-1', 'galaxie-3']
    if reload:
        other = build()
        assert asyncio.run(other._restore(*stored(executor), 'bound')) == 's'
        executor = other
    assert run(executor, prompt='again') == 'second'
    identifiers = [part.function_call.id for event in events(executor) if event.content
                   for part in event.content.parts or [] if part.function_call]
    assert identifiers == ['galaxie-1', 'galaxie-3', 'galaxie-4']
    scopes = [payload['effectScope'] for op, payload in seen if op == 'capability']
    assert scopes == ['adk-python/s/root/0/0/inner/root/0/0',
                      'adk-python/s/root/1/0', 'adk-python/s/root/2/0']
    assert len(set(scopes)) == len(scopes)
    assert [payload.get('inner', False) for op, payload in seen if op == 'capability'] == [True, False, False]


@pytest.mark.parametrize('failure', ['unavailable', 'denied', 'budget_exceeded', 'executor_error'])
def test_inner_model_failures_match_outer_direct_codes_and_never_become_tool_text(failure):
    direct_seen = []
    script([failure], direct_seen)
    assert code_of(lambda: run(Executor(leaf('outer')))) == failure
    seen = []
    script([call(), failure, {'content': 'must not dispatch'}], seen)
    executor = Executor(root())
    assert code_of(lambda: run(executor)) == failure
    assert [payload['role'] for _, payload in seen] == ['outer', 'inner']
    assert events(executor) == []


@pytest.mark.parametrize('failure', ['unavailable', 'budget_exceeded', 'executor_error'])
def test_fatal_inner_binding_failures_match_direct_binding_controls(failure):
    script([call('read', '{"value":1}'), failure])
    assert code_of(lambda: run(Executor(leaf('outer', tools=[read_tool()])))) == failure
    seen = []
    script([call(), call('read', '{"value":1}'), failure, {'content': 'must not dispatch'}], seen)
    executor = Executor(root(inner_tools=[read_tool()]))
    assert code_of(lambda: run(executor)) == failure
    assert [(op, payload.get('role')) for op, payload in seen] == [
        ('model', 'outer'), ('model', 'inner'), ('capability', None),
    ]
    assert events(executor) == []


@pytest.mark.parametrize('failure', ['denied', 'invalid'])
def test_model_visible_inner_capability_errors_keep_fixed_messages(failure):
    seen = []
    script([call(), call('read', '{"value":1}'), failure,
            {'content': 'inner answer'}, {'content': 'outer answer'}], seen)
    assert run(Executor(root(inner_tools=[read_tool()]))) == 'outer answer'
    inner_retry = seen[3][1]['messages'][-1]
    assert json.loads(inner_retry['content']) == {'error': _bridge.ERROR_MESSAGES[failure]}
    assert seen[-1][1]['messages'][-1]['content'] == '{"result":"inner answer"}'


def test_cancelling_an_inner_model_ends_the_whole_run_and_rolls_back():
    seen = []

    async def measure():
        started = asyncio.Event()

        async def transport(raw):
            message = json.loads(raw)
            seen.append(message['payload']['role'])
            if message['payload']['role'] == 'inner':
                started.set()
                await asyncio.Future()
            return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': call()})

        _bridge.install_transport(transport)
        executor = Executor(root())
        task = asyncio.create_task(executor.run({'prompt': 'go'}, 's', 10))
        await asyncio.wait_for(started.wait(), 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert events(executor) == []

    asyncio.run(measure())
    assert seen == ['outer', 'inner']


def test_inner_error_events_end_the_whole_run_before_another_outer_request(monkeypatch):
    original = face._GalaxieLlm.generate_content_async

    async def generate(self, request, stream=False):
        if self.role == 'inner':
            yield LlmResponse(error_code='SCRIPTED', error_message='scripted failure')
        else:
            async for response in original(self, request, stream):
                yield response

    monkeypatch.setattr(face._GalaxieLlm, 'generate_content_async', generate)
    seen = []
    script([call(), {'content': 'must not dispatch'}], seen)
    executor = Executor(root())
    assert code_of(lambda: run(executor)) == 'executor_error'
    assert [payload['role'] for _, payload in seen] == ['outer']
    assert events(executor) == []


class Input(BaseModel):
    request: str


@pytest.mark.parametrize('kind', [
    'raw', 'nested', 'confirmation', 'long-running', 'request-input', 'input-schema', 'output-schema',
    'model', 'foreign-class', 'duplicate', 'tool-name', 'exit', 'toolset',
])
def test_static_refusals_dispatch_nothing(kind):
    dispatched = []

    async def forbidden(raw):
        dispatched.append(raw)
        pytest.fail('prepare must not dispatch')

    _bridge.install_transport(forbidden)
    inner = leaf()
    if kind == 'nested':
        inner.tools = [agent_tool(leaf('nested'))]
    if kind in ('confirmation', 'long-running'):
        inner.tools = [capability_tool('read', 'notes.read@1', PARAMETERS, 'Read.',
                       require_confirmation=kind == 'confirmation', long_running=kind == 'long-running')]
    if kind == 'request-input':
        def adk_request_input(request: str) -> str:
            return request
        inner.tools = [FunctionTool(adk_request_input)]
    if kind == 'input-schema':
        inner.input_schema = Input
    if kind == 'output-schema':
        inner.output_schema = Input
    if kind == 'model':
        inner.model = ''
    if kind == 'foreign-class':
        class Foreign(LlmAgent):
            pass
        inner = Foreign(name='inner', model=llm('inner'))
    if kind == 'duplicate':
        inner.name = 'outer'
    if kind == 'exit':
        inner.tools = [loop_exit()]
    if kind == 'toolset':
        inner.tools = [toolset([read_tool()])]
    wrapper = AgentTool(inner) if kind == 'raw' else agent_tool(inner)
    tools = [wrapper, read_tool('inner')] if kind == 'tool-name' else [wrapper]
    assert code_of(lambda: Executor(leaf('outer', tools=tools))) == 'unsupported'
    assert dispatched == []


def test_successful_wrapper_turn_restores_equal_history_and_failed_turn_leaves_no_state():
    def build():
        executor = Executor(root(output_key='changed'))
        executor.durable = True
        return executor

    seen = []
    script([call(), {'content': 'inner answer'}, {'content': 'first'}], seen)
    original = build()
    assert run(original, prompt='one') == 'first'
    before = stored(original)
    other = build()
    assert asyncio.run(other._restore(*before, 'bound')) == 's'
    assert stored(other) == before
    script([call(), {'content': 'failed inner'}, 'unavailable'], seen)
    assert code_of(lambda: run(other, prompt='failed')) == 'unavailable'
    assert stored(other) == before
    assert other._sessions.sessions['galaxie']['galaxie']['s'].state == {'changed': 'inner answer'}
    script([{'content': 'second'}], seen)
    assert run(other, prompt='two') == 'second'
    history = [(message['role'], message['content']) for message in seen[-1][1]['messages']
               if message['role'] != 'system']
    assert history == [('user', 'one'), ('assistant', ''), ('tool', '{"result":"inner answer"}'),
                       ('assistant', 'first'), ('user', 'two')]


def test_failed_then_retried_wrapper_turn_reuses_inner_scope_and_keeps_outer_ids_unique():
    seen = []
    executor = Executor(root(inner_tools=[read_tool()], outer_tools=[read_tool('outside')]))
    executor.durable = True
    script([{'content': 'baseline'}], seen)
    assert run(executor, prompt='one') == 'baseline'
    before = stored(executor)
    script([call(), call('read', '{"value":1}'), {'value': 2}, {'content': 'inner answer'},
            'unavailable'], seen)
    assert code_of(lambda: run(executor, prompt='retry')) == 'unavailable'
    assert stored(executor) == before
    script([call(), call('read', '{"value":1}'), {'value': 2}, {'content': 'inner answer'},
            call('outside', '{"value":2}'), {'value': 4}, {'content': 'done'}], seen)
    assert run(executor, prompt='retry') == 'done'
    scopes = [payload['effectScope'] for op, payload in seen if op == 'capability']
    assert scopes == ['adk-python/s/root/0/0/inner/root/0/0'] * 2 + ['adk-python/s/root/1/0']
    identifiers = [part.function_call.id for event in events(executor) if event.content
                   for part in event.content.parts or [] if part.function_call]
    assert identifiers == ['galaxie-1', 'galaxie-3']
