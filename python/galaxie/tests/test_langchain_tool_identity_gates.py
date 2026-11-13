# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native gate measurements for the driver-scoped tool candidate."""

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage, RemoveMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.errors import GraphRecursionError
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.graph.message import REMOVE_ALL_MESSAGES
from langgraph.prebuilt import ToolNode

from galaxie import GalaxieError, _bridge
from galaxie.langchain import GalaxieChatModel
from test_langchain_tool_calls import CALL, SCHEMA, PlainSchema, plain_tool, transport_for

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tests/conformance/cases-python'))
from test_tool_call_replies_native import loop, native_record
from tool_scope import ScopedGraph, current, execution
from tool_scoped_candidate import ScopedToolCandidate, scoped_capability_tool


TERMINAL = ['budget_exceeded', 'cancelled', 'timeout', 'unavailable', 'outcome_unknown', 'unrecoverable']


def helper():
    return scoped_capability_tool('read', 'read@1', SCHEMA, 'Read a value.')


def bound(choice=None):
    return ScopedToolCandidate(role='answer', disable_streaming=True).bind_tools([helper()], tool_choice=choice)


def response(message):
    if message['op'] == 'capability':
        return {'ok': True, 'payload': '4'}
    return {'ok': True, 'payload': ({'content': 'done'} if message['payload']['messages'][-1]['role'] == 'tool'
                                   else {'content': '', 'toolCalls': [CALL]})}


async def run(graph, *, session='same-session', limit=20, value=None):
    value = value if value is not None else {'messages': [HumanMessage('request')]}
    return [item async for item in ScopedGraph(graph).astream(value,
        {'configurable': {'thread_id': session}, 'recursion_limit': limit}, stream_mode='values')]


def failure_graph(handler, silent=False, again=False):
    model, tool = bound(), helper()

    async def chat(state, config: RunnableConfig):
        return {'messages': [await model.ainvoke(state['messages'], config)]}

    async def work(state, config: RunnableConfig):
        result = await ToolNode([tool], handle_tool_errors=handler).ainvoke(state, config)
        if again:
            await tool.ainvoke({'value': 2}, config)
        return result

    return (StateGraph(MessagesState).add_node('model', chat).add_node('tools', work)
            .add_edge(START, 'model').add_edge('model', 'tools')
            .add_edge('tools', END if silent else 'finish')
            .add_node('finish', chat).add_edge('finish', END)
            .compile(checkpointer=InMemorySaver()))


@pytest.mark.parametrize('code', TERMINAL)
@pytest.mark.parametrize('handler', [True, lambda error: 'handled'])
@pytest.mark.parametrize('shape', ['next-model', 'silent', 'next-helper'])
def test_g45_original_terminal_code_survives_every_swallow_shape(code, handler, shape):
    def fail(message):
        return {'ok': False, 'error': {'code': code}} if message['op'] == 'capability' else response(message)

    seen = transport_for(fail)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(run(failure_graph(handler, silent=shape == 'silent', again=shape == 'next-helper')))
    assert error.value.code == code
    assert [message['op'] for message in seen] == ['model', 'capability']
    assert seen[-1]['payload']['tool'] is True
    assert current.get() is None


@pytest.mark.parametrize('session', ['same-session', 'another-session'])
def test_g46_fresh_execution_has_no_latch_even_on_the_same_graph(session):
    graph = loop(bound(), [helper()], handler=True)
    seen = transport_for(lambda message: {'ok': False, 'error': {'code': 'unavailable'}}
                         if message['op'] == 'capability' else response(message))
    with pytest.raises(GalaxieError):
        asyncio.run(run(graph))
    seen.clear()
    transport_seen = transport_for(response)
    value: Any = {'messages': [RemoveMessage(id=REMOVE_ALL_MESSAGES), HumanMessage('request')]}
    result = asyncio.run(run(graph, session=session, value=value))
    assert result[-1]['messages'][-1].content == 'done'
    assert [message['op'] for message in transport_seen] == ['model', 'capability', 'model']


def test_g41_model_denial_is_latched_even_if_the_node_swallows_it():
    seen = transport_for(lambda _: {'ok': False, 'error': {'code': 'denied'}})

    async def swallow(state):
        try:
            await bound().ainvoke([HumanMessage('blocked arguments')])
        except GalaxieError:
            pass
        return state

    graph = (StateGraph(MessagesState).add_node('swallow', swallow)
             .add_edge(START, 'swallow').add_edge('swallow', END).compile())
    with pytest.raises(GalaxieError) as error:
        asyncio.run(run(graph))
    assert error.value.code == 'denied'
    assert [message['op'] for message in seen] == ['model']


def test_g42_tool_budget_failure_escapes_the_default_handler():
    seen = transport_for(lambda message: {'ok': False, 'error': {'code': 'budget_exceeded'}}
                         if message['op'] == 'capability' else response(message))
    with pytest.raises(GalaxieError) as error:
        asyncio.run(run(loop(bound(), [helper()])))
    assert error.value.code == 'budget_exceeded'
    assert [message['op'] for message in seen] == ['model', 'capability']


def test_g43_recursion_exhaustion_bounds_the_endless_loop():
    seen = transport_for(lambda message: {'ok': True, 'payload': '4'} if message['op'] == 'capability'
                         else {'ok': True, 'payload': {'content': '', 'toolCalls': [CALL]}})
    with pytest.raises(GraphRecursionError):
        asyncio.run(run(loop(bound(), [helper()]), limit=4))
    assert [message['op'] for message in seen] == ['model', 'capability', 'model', 'capability']


def test_g44_refused_destination_stops_after_private_tool_result():
    def private(message):
        if message['op'] == 'model' and message['payload']['messages'][-1]['role'] == 'tool':
            return {'ok': False, 'error': {'code': 'denied'}}
        return response(message)

    seen = transport_for(private)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(run(loop(bound(), [helper()])))
    assert error.value.code == 'denied'
    assert [message['op'] for message in seen] == ['model', 'capability', 'model']


def test_g47_observe_inflight_sibling_checkpoints_and_failed_history():
    async def exercise():
        sibling_started = asyncio.Event()
        operations, completed, writes = [], [], []

        class CountingSaver(InMemorySaver):
            async def aput(self, *args, **kwargs):
                scope = current.get()
                writes.append(('checkpoint', scope.failure if scope else None))
                return await super().aput(*args, **kwargs)

            async def aput_writes(self, *args, **kwargs):
                scope = current.get()
                writes.append(('pending', scope.failure if scope else None))
                return await super().aput_writes(*args, **kwargs)

        async def transport(raw):
            message = json.loads(raw)
            operations.append(message['op'])
            if message['op'] == 'model':
                reply = response(message)
                if message['payload']['messages'][-1]['role'] != 'tool':
                    reply['payload']['toolCalls'] = [CALL, {**CALL, 'id': 'call-2'}]
            elif operations.count('capability') == 1:
                await sibling_started.wait()
                reply = {'ok': False, 'error': {'code': 'unavailable'}}
            else:
                sibling_started.set()
                scope = current.get()
                assert scope is not None
                while scope.failure is None:
                    await asyncio.sleep(0)
                completed.append(scope.failure)
                reply = {'ok': True, 'payload': '4'}
            return json.dumps({key: message[key] for key in ('v', 'id', 'op')} |
                              {'kind': 'response', **reply})

        _bridge.install_transport(transport)
        graph = loop(bound(), [helper()], handler=True)
        graph.checkpointer = CountingSaver()
        with pytest.raises(GalaxieError) as error:
            await run(graph)
        assert error.value.code == 'unavailable'
        assert operations == ['model', 'capability', 'capability']
        assert completed == ['unavailable']
        assert any(code == 'unavailable' for _, code in writes)
        before = operations.copy()
        with pytest.raises(GalaxieError) as error:
            await run(graph, value=None)
        assert error.value.code == 'unsupported'
        assert operations == before

    asyncio.run(exercise())


@pytest.mark.parametrize('hostile_error', [False, True])
def test_g48_hostile_content_never_enters_scope_error_or_post_latch_requests(hostile_error):
    marker = 'PRIVATE-MARKER-identity-gate-48'
    code = 'invalid' if hostile_error else 'timeout'
    seen = transport_for(lambda _: {'ok': False, 'error': {
        'code': 'timeout', **({'message': marker} if hostile_error else {}),
    }})

    async def exercise():
        with execution() as scope:
            with pytest.raises(GalaxieError):
                await helper().ainvoke({'value': marker})
            assert scope.failure == code
            assert marker not in repr(scope)
            assert set(type(scope).__slots__) == {'id', 'failure'}
            before = len(seen)
            for action in (helper().ainvoke({'value': marker}), bound().ainvoke([HumanMessage(marker)])):
                with pytest.raises(GalaxieError) as error:
                    await action
                assert error.value.code == code
                assert marker not in str(error.value)
            assert len(seen) == before

    with pytest.raises(GalaxieError) as error:
        asyncio.run(exercise())
    assert error.value.code == code
    assert marker not in str(error.value)


@pytest.mark.parametrize('choice', [None, 'auto', 'none', 'required', 'read'])
def test_g11_wire_and_history_preserve_declarations_choices_ids_and_arguments(choice):
    seen = transport_for(response)

    async def exercise():
        with execution():
            model = bound(choice)
            reply = await model.ainvoke([HumanMessage('request')])
            assert reply.tool_calls == [{'id': 'call-1', 'name': 'read', 'args': {'value': 2}, 'type': 'tool_call'}]
            payload = model._payload([reply, ToolMessage('4', tool_call_id='call-1')], None)
            assert payload['messages'] == [
                {'role': 'assistant', 'content': '', 'toolCalls': [CALL]},
                {'role': 'tool', 'content': '4', 'tool_call_id': 'call-1'},
            ]

    asyncio.run(exercise())
    assert seen[0]['payload']['options']['tools'] == [{
        'type': 'function', 'function': {'name': 'read', 'description': 'Read a value.', 'parameters': SCHEMA},
    }]
    mapped = {'type': 'function', 'function': {'name': 'read'}} if choice == 'read' else choice
    assert seen[0]['payload']['options'].get('toolChoice') == mapped


@pytest.mark.parametrize('calls', [
    [{**CALL, 'function': {'name': 'read', 'arguments': '[]'}}],
    [{**CALL, 'function': {'name': 'read', 'arguments': '{'}}],
    [CALL, CALL], [{**CALL, 'function': {'name': '', 'arguments': '{}'}}],
    [{**CALL, 'function': {'name': 'unoffered', 'arguments': '{}'}}],
])
def test_g14_invalid_reply_stops_before_any_capability(calls):
    seen = transport_for(lambda _: {'ok': True, 'payload': {'content': '', 'toolCalls': calls}})
    with pytest.raises(GalaxieError) as error:
        asyncio.run(run(loop(bound(), [helper()])))
    assert error.value.code == 'invalid'
    assert [message['op'] for message in seen] == ['model']


def test_g15_toolless_text_and_unbound_history_keep_existing_behavior():
    seen = transport_for(lambda _: {'ok': True, 'payload': {'content': 'done'}})

    async def exercise():
        with execution():
            assert (await ScopedToolCandidate(role='answer').ainvoke([HumanMessage('request')])).content == 'done'
        with execution():
            await ScopedToolCandidate(role='answer').ainvoke([AIMessage('', tool_calls=[{
                'name': 'read', 'args': {'value': 2}, 'id': 'call-1',
            }])])

    with pytest.raises(GalaxieError) as error:
        asyncio.run(exercise())
    assert error.value.code == 'unsupported'
    assert len(seen) == 1
    # The unchanged proxy tests separately cover text streaming and schema refusals.
    assert GalaxieChatModel(role='answer')._payload([HumanMessage('request')], None)['options'] == {}


def test_g34_dict_schema_reaches_broker_before_invalid_argument_failure():
    seen = transport_for(lambda _: {'ok': False, 'error': {'code': 'invalid'}})

    async def exercise():
        with execution():
            await helper().ainvoke({'value': 'not-an-integer'})

    with pytest.raises(GalaxieError) as error:
        asyncio.run(exercise())
    assert error.value.code == 'invalid'
    assert seen[0]['op'] == 'capability'
    assert seen[0]['payload']['input'] == {'value': 'not-an-integer'}


@pytest.mark.parametrize('tools,kwargs', [
    ([plain_tool], {}), ([lambda: None], {}), ([{'type': 'function'}], {}), ([PlainSchema], {}),
    ([], {'strict': True}), ([], {'tool_choice': 'missing'}), ([], {'tool_choice': {}}),
])
def test_g61_binding_refusals_precede_transport(tools, kwargs):
    seen = transport_for(lambda _: pytest.fail('Unexpected transport.'))
    with pytest.raises(GalaxieError) as error:
        ScopedToolCandidate(role='answer').bind_tools(tools, **kwargs)
    assert error.value.code == 'unsupported'
    assert seen == []


def test_g61_names_bounds_duplicates_and_function_output():
    seen = transport_for(lambda _: pytest.fail('Unexpected transport.'))
    for name in ('', 'bad-name', '1read', 'a' * 65):
        with pytest.raises(GalaxieError) as error:
            scoped_capability_tool(name, 'read@1', SCHEMA, 'Read.')
        assert error.value.code == 'invalid'
    for action, code in (
        (lambda: ScopedToolCandidate(role='answer').bind_tools([helper(), helper()]), 'invalid'),
        (lambda: scoped_capability_tool('read', 'read@1', {'type': 'object', 'description': 'x' * 1_048_576}, 'Read.'), 'unsupported'),
        (lambda: ScopedToolCandidate(role='answer').with_structured_output(PlainSchema), 'unsupported'),
    ):
        with pytest.raises(GalaxieError) as error:
            action()
        assert error.value.code == code
    assert seen == []


@pytest.mark.parametrize('message', [
    HumanMessage([{'type': 'image_url', 'image_url': {'url': 'PRIVATE-MARKER'}}]),
    AIMessage([{'type': 'text', 'text': 'PRIVATE-MARKER'}]),
    ToolMessage(['PRIVATE-MARKER'], tool_call_id='call-1'),
    ToolMessage('PRIVATE-MARKER', tool_call_id='call-1', artifact={'private': True}),
    ToolMessage('PRIVATE-MARKER', tool_call_id='call-1', status='error'),
    ToolMessage('PRIVATE-MARKER', tool_call_id='orphan'),
])
def test_g62_history_refusals_are_fixed_and_precede_transport(message):
    seen = transport_for(lambda _: pytest.fail('Unexpected transport.'))

    async def exercise():
        with execution():
            await bound().ainvoke([message])

    with pytest.raises(GalaxieError) as error:
        asyncio.run(exercise())
    assert error.value.code in ('unsupported', 'invalid')
    assert 'PRIVATE-MARKER' not in str(error.value)
    assert seen == []
