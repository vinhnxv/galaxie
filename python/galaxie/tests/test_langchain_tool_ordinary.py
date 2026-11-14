# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio

import pytest
from langchain_core.messages import HumanMessage

from galaxie import GalaxieError
from test_langchain_tool_calls import SCHEMA, transport_for
from test_tool_call_replies_native import ToolReplyModel, loop
from tool_ordinary import ordinary_tool


def exercise(tool, arguments=None, handler=None):
    graph = loop(ToolReplyModel(calls=[{'name': tool.name, 'args': arguments or {'value': 2}, 'id': 'call'}]),
                 [tool], handler=handler)
    return asyncio.run(graph.ainvoke({'messages': [HumanMessage('request')]},
                                    {'configurable': {'thread_id': 'ordinary'}}))


@pytest.mark.parametrize('code', ['budget_exceeded', 'cancelled', 'timeout', 'unavailable',
                                 'outcome_unknown', 'unrecoverable', 'denied', 'invalid'])
def test_default_handler_propagates_fixed_bridge_codes(code):
    seen = transport_for(lambda _: {'ok': False, 'error': {'code': code}})
    with pytest.raises(GalaxieError) as error:
        exercise(ordinary_tool())
    assert error.value.code == code
    assert len(seen) == 1
    assert seen[0]['payload']['tool'] is True


@pytest.mark.parametrize('handler', [True, lambda error: 'Handled tool error.'])
def test_explicit_handler_can_swallow_terminal_failure(handler):
    seen = transport_for(lambda _: {'ok': False, 'error': {'code': 'budget_exceeded'}})
    result = exercise(ordinary_tool(), handler=handler)
    assert result['messages'][-2].status == 'error'
    assert result['messages'][-1].content == 'done'
    assert len(seen) == 1


def test_pydantic_validation_is_native_text_before_transport():
    seen = transport_for(lambda _: pytest.fail('Unexpected broker request.'))
    result = exercise(ordinary_tool(pydantic=True), {'value': 'bad'})
    assert result['messages'][-2].status == 'error'
    assert result['messages'][-1].content == 'done'
    assert seen == []


def test_dict_schema_reaches_transport_and_keeps_invalid():
    seen = transport_for(lambda _: {'ok': False, 'error': {'code': 'invalid'}})
    with pytest.raises(GalaxieError) as error:
        exercise(ordinary_tool(), {'value': 'bad'})
    assert error.value.code == 'invalid'
    assert seen[0]['payload']['input'] == {'value': 'bad'}
    assert ordinary_tool().args_schema == SCHEMA


@pytest.mark.parametrize('flagged', [False, True])
def test_ordinary_body_preserves_arguments_and_flag(flagged):
    seen = transport_for(lambda _: {'ok': True, 'payload': {'output': '4'}})
    result = exercise(ordinary_tool(flagged=flagged))
    assert result['messages'][-1].content == 'done'
    assert seen[0]['payload']['input'] == {'value': 2}
    assert seen[0]['payload'].get('tool', False) is flagged


def test_invalid_tool_flag_fails_before_transport():
    seen = transport_for(lambda _: pytest.fail('Unexpected broker request.'))
    with pytest.raises(GalaxieError) as error:
        exercise(ordinary_tool(flagged='bad'))
    assert error.value.code == 'invalid'
    assert seen == []


@pytest.mark.parametrize('ordinary', [False, True])
def test_result_label_refusal_matches_direct_transport_path(ordinary):
    from galaxie import capabilities
    from galaxie.langchain import GalaxieChatModel

    labelled = False

    def respond(message):
        nonlocal labelled
        if message['op'] == 'capability':
            labelled = True
            return {'ok': True, 'payload': 'private result'}
        assert labelled
        return {'ok': False, 'error': {'code': 'denied'}}

    seen = transport_for(respond)

    async def run():
        if ordinary:
            await ordinary_tool().ainvoke({'value': 2})
        else:
            await capabilities.call('read@1', {'value': 2})
        await GalaxieChatModel(role='answer').ainvoke([HumanMessage('next')])

    with pytest.raises(GalaxieError) as error:
        asyncio.run(run())
    assert error.value.code == 'denied'
    assert [message['op'] for message in seen] == ['capability', 'model']


@pytest.mark.parametrize('ordinary', [False, True])
def test_counted_transport_budget_matches_direct_path(ordinary):
    from galaxie import capabilities

    dispatched = 0

    def respond(message):
        nonlocal dispatched
        if dispatched == 2:
            return {'ok': False, 'error': {'code': 'budget_exceeded'}}
        dispatched += 1
        return {'ok': True, 'payload': '4'}

    seen = transport_for(respond)

    async def run():
        for _ in range(3):
            if ordinary:
                await ordinary_tool().ainvoke({'value': 2})
            else:
                await capabilities.call('read@1', {'value': 2})

    with pytest.raises(GalaxieError) as error:
        asyncio.run(run())
    assert error.value.code == 'budget_exceeded'
    assert dispatched == 2
    assert len(seen) == 3
