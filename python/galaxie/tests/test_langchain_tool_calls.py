# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

# Gate | Observed | Result
# G1.1 | declarations, choices, IDs, parsed arguments and tool history | CPython pass
# G4.5 | handler loses original code; later helper still reaches bridge | fail
# G4.6 | no latch built; thread reuse and task-root evidence in native file | not applicable
# Other SUPPORTED-family gates | outcome fixed by G4.5 | not measured
# G6.1/G6.2 | candidate refuses before transport; shipped bind is unimplemented
# Decisions C1-C5 await AL in Node; no production source may ship.

import asyncio
import json
import sys
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from pydantic import BaseModel

from galaxie import GalaxieError, _bridge
from galaxie.langchain import GalaxieChatModel

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tests/conformance/cases-python'))
from test_tool_call_replies_native import loop
from tool_candidate import ToolCandidate, capability_tool

SCHEMA = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}
CALL = {'id': 'call-1', 'type': 'function', 'function': {'name': 'read', 'arguments': '{"value":2}'}}


def bound(choice=None):
    return ToolCandidate(role='answer').bind_tools([
        capability_tool('read', 'read@1', SCHEMA, 'Read a value.'),
    ], tool_choice=choice)


def transport_for(handler):
    seen = []

    async def transport(raw):
        message = json.loads(raw)
        seen.append(message)
        reply = handler(message)
        return json.dumps({key: message[key] for key in ('v', 'id', 'op')} | {'kind': 'response', **reply})

    _bridge.install_transport(transport)
    return seen


@pytest.mark.parametrize('choice', [None, 'auto', 'none', 'required', 'read'])
def test_candidate_wire_preserves_declarations_choice_arguments_and_history(choice):
    seen = transport_for(lambda _: {'ok': True, 'payload': {'content': '', 'toolCalls': [CALL]}})
    model = bound(choice)
    reply = asyncio.run(model.ainvoke([HumanMessage('request')]))
    assert reply.tool_calls == [{'id': 'call-1', 'name': 'read', 'args': {'value': 2}, 'type': 'tool_call'}]
    payload = model._payload([reply, ToolMessage('4', tool_call_id='call-1')], None)
    assert payload['messages'] == [
        {'role': 'assistant', 'content': '', 'toolCalls': [CALL]},
        {'role': 'tool', 'content': '4', 'tool_call_id': 'call-1'},
    ]
    assert seen[0]['payload']['options']['tools'] == [{
        'type': 'function', 'function': {'name': 'read', 'description': 'Read a value.', 'parameters': SCHEMA},
    }]
    mapped = {'type': 'function', 'function': {'name': 'read'}} if choice == 'read' else choice
    assert seen[0]['payload']['options'].get('toolChoice') == mapped


@pytest.mark.parametrize('code', ['budget_exceeded', 'cancelled', 'timeout', 'unavailable', 'outcome_unknown', 'unrecoverable'])
@pytest.mark.parametrize('handler', [True, lambda error: 'handled'])
def test_unshipped_candidate_cannot_contain_swallowed_terminal_failures(code, handler):
    def response(message):
        if message['op'] == 'capability':
            return {'ok': False, 'error': {'code': code}}
        messages = message['payload']['messages']
        return {'ok': True, 'payload': ({'content': 'done'} if messages[-1]['role'] == 'tool'
                                       else {'content': '', 'toolCalls': [CALL]})}

    seen = transport_for(response)
    helper = capability_tool('read', 'read@1', SCHEMA, 'Read a value.')
    graph = loop(bound(), [helper], handler=handler)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(graph.ainvoke({'messages': [HumanMessage('request')]},
                                 {'configurable': {'thread_id': 'same-session'}}))
    # The error-status refusal stops this history, but loses the terminal code.
    assert error.value.code == 'unsupported'
    assert [message['op'] for message in seen] == ['model', 'capability']
    assert seen[1]['payload']['tool'] is True
    # No latch blocks a later helper request in the same Python-visible session.
    with pytest.raises(GalaxieError) as error:
        asyncio.run(helper.ainvoke({'value': 2}, {'configurable': {'thread_id': 'same-session'}}))
    assert error.value.code == code
    assert [message['op'] for message in seen] == ['model', 'capability', 'capability']


def test_denied_is_fixed_model_text_and_default_terminal_errors_escape():
    helper = capability_tool('read', 'read@1', SCHEMA, 'Read a value.')
    transport_for(lambda _: {'ok': False, 'error': {'code': 'denied'}})
    assert asyncio.run(helper.ainvoke({'value': 2})) == 'Policy denied the request.'
    transport_for(lambda _: {'ok': False, 'error': {'code': 'unavailable'}})
    with pytest.raises(GalaxieError) as error:
        asyncio.run(helper.ainvoke({'value': 2}))
    assert error.value.code == 'unavailable'


@tool
def plain_tool(value: int) -> str:
    """An ordinary author tool."""
    return str(value)


class PlainSchema(BaseModel):
    value: int


@pytest.mark.parametrize('tools,kwargs,code', [
    ([plain_tool], {}, 'unsupported'), ([lambda: None], {}, 'unsupported'),
    ([{'type': 'function', 'function': {'name': 'plain'}}], {}, 'unsupported'),
    ([PlainSchema], {}, 'unsupported'), ([], {'strict': True}, 'unsupported'),
    ([], {'tool_choice': 'missing'}, 'unsupported'), ([], {'tool_choice': {}}, 'unsupported'),
])
def test_candidate_refuses_non_capability_bindings_before_transport(tools, kwargs, code):
    seen = transport_for(lambda _: pytest.fail('Unexpected transport request.'))
    with pytest.raises(GalaxieError) as error:
        ToolCandidate(role='answer').bind_tools(tools, **kwargs)
    assert error.value.code == code
    assert seen == []


@pytest.mark.parametrize('name', ['', 'invalid-name', '1read', 'a' * 65])
def test_candidate_refuses_invalid_tool_names_without_requests(name):
    seen = transport_for(lambda _: pytest.fail('Unexpected transport request.'))
    with pytest.raises(GalaxieError) as error:
        capability_tool(name, 'read@1', SCHEMA, 'Read.')
    assert error.value.code == 'invalid'
    assert seen == []


def test_candidate_refuses_duplicate_names_oversized_schemas_and_function_output():
    seen = transport_for(lambda _: pytest.fail('Unexpected transport request.'))
    helper = capability_tool('read', 'read@1', SCHEMA, 'Read.')
    with pytest.raises(GalaxieError) as error:
        ToolCandidate(role='answer').bind_tools([helper, helper])
    assert error.value.code == 'invalid'
    with pytest.raises(GalaxieError) as error:
        capability_tool('read', 'read@1', {'type': 'object', 'description': 'x' * 1_048_576}, 'Read.')
    assert error.value.code == 'unsupported'
    with pytest.raises(GalaxieError) as error:
        ToolCandidate(role='answer').with_structured_output(PlainSchema)
    assert error.value.code == 'unsupported'
    assert seen == []


@pytest.mark.parametrize('message', [
    HumanMessage([{'type': 'image_url', 'image_url': {'url': 'PRIVATE'}}]),
    AIMessage([{'type': 'text', 'text': 'PRIVATE'}]),
    ToolMessage(['PRIVATE'], tool_call_id='call-1'),
    ToolMessage('PRIVATE', tool_call_id='call-1', artifact={'private': True}),
    ToolMessage('PRIVATE', tool_call_id='call-1', status='error'),
    ToolMessage('PRIVATE', tool_call_id='orphan'),
])
def test_candidate_refuses_unsupported_tool_history_before_transport(message):
    seen = transport_for(lambda _: pytest.fail('Unexpected transport request.'))
    with pytest.raises(GalaxieError) as error:
        asyncio.run(bound().ainvoke([message]))
    assert error.value.code in ('unsupported', 'invalid')
    assert 'PRIVATE' not in str(error.value)
    assert seen == []


def test_shipped_proxy_still_refuses_tool_parts_and_has_no_binding_implementation():
    seen = transport_for(lambda _: pytest.fail('Unexpected transport request.'))
    model = GalaxieChatModel(role='answer')
    with pytest.raises(NotImplementedError):
        model.bind_tools([plain_tool])
    with pytest.raises(GalaxieError) as error:
        asyncio.run(model.ainvoke([AIMessage(content='', tool_calls=[{
            'id': 'call-1', 'name': 'read', 'args': {'value': 2},
        }])]))
    assert error.value.code == 'unsupported'
    with pytest.raises(GalaxieError) as error:
        model._message({'content': '', 'toolCalls': [CALL]})
    assert error.value.code == 'invalid'
    assert seen == []
