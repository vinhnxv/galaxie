# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Candidate-only AgentTool tests; reverted together with an unadmitted candidate."""

import asyncio
import json

import pytest
from google.adk.agents import LlmAgent
from google.adk.tools import AgentTool

from galaxie import GalaxieError, _bridge
from galaxie.adk import Executor, agent_tool, capability_tool, llm


def leaf(name='inner', **options):
    return LlmAgent(name=name, model=llm(name), **options)


@pytest.mark.parametrize('kind', ['raw', 'nested', 'confirmation', 'long-running', 'model', 'duplicate', 'schema'])
def test_static_refusals_precede_bridge_dispatch(kind):
    async def forbidden(raw):
        pytest.fail('prepare must not dispatch')
    _bridge.install_transport(forbidden)
    inner = leaf()
    if kind == 'nested':
        inner.tools = [agent_tool(leaf('nested'))]
    if kind in ('confirmation', 'long-running'):
        inner.tools = [capability_tool('read', 'notes.read@1', {'type': 'object'}, 'Read.',
                                      require_confirmation=kind == 'confirmation', long_running=kind == 'long-running')]
    if kind == 'model':
        inner.model = ''
    if kind == 'duplicate':
        inner.name = 'outer'
    if kind == 'schema':
        inner.output_schema = {'type': 'object'}
    with pytest.raises(GalaxieError) as error:
        Executor(leaf('outer', tools=[AgentTool(inner) if kind == 'raw' else agent_tool(inner)]))
    assert error.value.code == 'unsupported'


def test_foreign_helper_input_is_invalid():
    with pytest.raises(GalaxieError) as error:
        agent_tool(object())
    assert error.value.code == 'invalid'


def test_wrapper_runs_three_routed_requests_and_stores_only_outer_events():
    replies = iter([
        {'content': '', 'toolCalls': [{'id': 'provider', 'type': 'function', 'function': {
            'name': 'inner', 'arguments': '{"request":"question"}',
        }}]}, {'content': 'inner answer'}, {'content': 'outer answer'},
    ])
    seen = []
    async def transport(raw):
        message = json.loads(raw)
        seen.append(message['payload'])
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': next(replies)})
    _bridge.install_transport(transport)
    executor = Executor(leaf('outer', tools=[agent_tool(leaf())]))
    assert asyncio.run(executor.run({'prompt': 'go'}, 's', 5)) == 'outer answer'
    assert [payload['role'] for payload in seen] == ['outer', 'inner', 'outer']
    events = executor._sessions.sessions['galaxie']['galaxie']['s'].events
    assert {event.author for event in events} == {'user', 'outer'}
    assert seen[-1]['messages'][-1]['content'] == '{"result":"inner answer"}'
