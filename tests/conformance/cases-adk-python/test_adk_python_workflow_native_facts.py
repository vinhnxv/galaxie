# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Pinned native Workflow event, state and retry facts with scripted models."""

import asyncio
from collections import Counter
from typing import Any

import pytest
from google.adk.agents import LlmAgent
from google.adk.agents.context import Context
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.adk.tools import FunctionTool
from google.adk.workflow import FunctionNode, JoinNode, Workflow
from google.genai import types


class Scripted(BaseLlm):
    ledger: Any
    writes: bool = False
    delayed: bool = False
    answer: str | None = None

    async def generate_content_async(self, llm_request, stream=False):
        self.ledger['requests'].append((self.model, llm_request.model_copy(deep=True)))
        if self.ledger.get('fail') == self.model:
            self.ledger['fail'] = None
            raise ValueError('scripted node failure')
        if self.delayed:
            await asyncio.sleep(0.01)
        answered = any(part.function_response for content in llm_request.contents for part in content.parts or [])
        if self.writes and not answered:
            parts = [types.Part(function_call=types.FunctionCall(name='write', args={'value': 1 if self.model == 'b' else 2}))]
        else:
            parts = [types.Part(text=self.answer if self.answer is not None else f'{self.model} answer')]
        yield LlmResponse(content=types.Content(role='model', parts=parts), turn_complete=True)


def ledger() -> dict[str, Any]:
    return {'requests': [], 'bodies': []}


def leaf(name, observed, *, writes=False, pause=False, delayed=False, answer=None):
    def write(value: int) -> dict:
        observed['bodies'].append(value)
        return {'value': value}

    return LlmAgent(name=name, output_key=f'{name}_result',
                    model=Scripted(model=name, ledger=observed, writes=writes, delayed=delayed, answer=answer),
                    tools=[FunctionTool(write, require_confirmation=pause)] if writes else [])


async def collect(runner, prompt):
    return [event async for event in runner.run_async(user_id='user', session_id='session',
            new_message=types.Content(role='user', parts=[types.Part(text=prompt)]))]


async def start(flow):
    runner = InMemoryRunner(node=flow, app_name='workflow')
    await runner.session_service.create_session(app_name='workflow', user_id='user', session_id='session')
    return runner


async def state(runner):
    session = await runner.session_service.get_session(app_name='workflow', user_id='user', session_id='session')
    assert session is not None
    return session.state


def message_events(events):
    return [event for event in events if event.content and any(part.text for part in event.content.parts or [])]


def test_native_finished_chain_restarts_node_paths_and_input_history_each_turn():
    observed = ledger()
    flow = Workflow(name='wf', edges=[('START', leaf('a', observed), leaf('b', observed))])

    async def measure():
        runner = await start(flow)
        try:
            turns = [await collect(runner, prompt) for prompt in ('first', 'second')]
            return turns, await state(runner)
        finally:
            await runner.close()

    turns, saved = asyncio.run(measure())
    assert [name for name, _ in observed['requests']] == ['a', 'b', 'a', 'b']
    for events in turns:
        authored = message_events(events)
        assert [event.author for event in authored] == ['a', 'b']
        assert [event.branch for event in authored] == [None, None]
        assert [event.node_info.path for event in authored] == ['wf@1/a@1', 'wf@1/b@1']
        assert [event.node_info.output_for for event in authored] == [['wf@1/a@1'], ['wf@1/b@1', 'wf@1']]
        assert all(event.node_info.message_as_output is True for event in authored)
        assert all(event.actions.agent_state is None and event.actions.end_of_agent is None
                   and event.actions.route is None for event in events)
        assert ''.join(part.text or '' for part in authored[-1].content.parts or []) == 'b answer'
    assert saved == {'a_result': 'a answer', 'b_result': 'b answer'}
    assert observed['bodies'] == []
    assert [request.contents[0].parts[0].text for _, request in observed['requests']] == [
        'first', 'a answer', 'second', 'a answer',
    ]
    assert all(len(request.contents) == 1 for _, request in observed['requests'])


@pytest.mark.parametrize('reverse', [False, True])
def test_native_fanout_join_keeps_branch_paths_when_write_arrival_is_reversed(reverse):
    observed = ledger()
    a = leaf('a', observed)
    b = leaf('b', observed, writes=True, delayed=reverse)
    c = leaf('c', observed, writes=True, delayed=not reverse)
    flow = Workflow(name='wf', edges=[('START', a, (b, c), JoinNode(name='join'))])

    async def measure():
        runner = await start(flow)
        try:
            return await collect(runner, 'fan out'), await state(runner)
        finally:
            await runner.close()

    events, saved = asyncio.run(measure())
    calls = [event for event in events if event.get_function_calls()]
    assert [event.author for event in calls] == (['c', 'b'] if reverse else ['b', 'c'])
    assert {event.author: (event.branch, event.node_info.path) for event in calls} == {
        'b': ('b@1', 'wf@1/b@1'), 'c': ('c@1', 'wf@1/c@1'),
    }
    assert observed['bodies'] == ([2, 1] if reverse else [1, 2])
    assert Counter(name for name, _ in observed['requests']) == {'a': 1, 'b': 2, 'c': 2}
    joined = [event for event in events if event.node_info and event.node_info.path == 'wf@1/join@1']
    assert len(joined) == 1
    assert joined[0].author == 'wf' and joined[0].branch is None
    assert joined[0].content is None
    assert joined[0].output == {'b': 'b answer', 'c': 'c answer'}
    assert joined[0].node_info.output_for == ['wf@1/join@1', 'wf@1']
    assert all(event.actions.agent_state is None and event.actions.end_of_agent is None
               and event.actions.route is None for event in events)
    assert saved == {'a_result': 'a answer', 'b_result': 'b answer', 'c_result': 'c answer'}


@pytest.mark.parametrize(('label', 'selected'), [('b', 'b'), ('unknown', 'c')])
def test_native_function_route_reads_upstream_text_and_declares_a_default(label, selected):
    observed = ledger()
    received = []

    def choose(node_input: Any, ctx: Context):
        assert isinstance(node_input, str)
        value = node_input
        received.append((value, ctx.node_path))
        ctx.route = value if value in ('b', 'c') else 'c'
        return value

    route = FunctionNode(name='choose', func=choose)
    flow = Workflow(name='wf', edges=[('START', leaf('a', observed, answer=label), route,
                    {'b': leaf('b', observed), 'c': leaf('c', observed)})])

    async def measure():
        runner = await start(flow)
        try:
            return await collect(runner, 'route'), await state(runner)
        finally:
            await runner.close()

    events, saved = asyncio.run(measure())
    assert received == [(label, 'wf@1/choose@1')]
    assert [name for name, _ in observed['requests']] == ['a', selected]
    routed = [event for event in events if event.actions.route is not None]
    assert len(routed) == 1
    assert routed[0].actions.route == selected
    assert routed[0].node_info.path == 'wf@1/choose@1'
    assert routed[0].output is None
    assert [event.output for event in events if event.node_info and event.node_info.path == 'wf@1/choose@1'
            and event.output is not None] == [label]
    assert message_events(events)[-1].author == selected
    assert saved == {'a_result': label, f'{selected}_result': f'{selected} answer'}


def test_native_failed_node_preserves_earlier_output_and_a_new_invocation_runs_the_chain_again():
    observed = ledger()
    observed['fail'] = 'b'
    flow = Workflow(name='wf', edges=[('START', leaf('a', observed), leaf('b', observed))])

    async def measure():
        runner = await start(flow)
        try:
            with pytest.raises(ValueError, match='scripted node failure'):
                await collect(runner, 'retry this')
            after_failure = dict(await state(runner))
            retried = await collect(runner, 'retry this')
            return after_failure, retried, await state(runner)
        finally:
            await runner.close()

    after_failure, retried, saved = asyncio.run(measure())
    assert [name for name, _ in observed['requests']] == ['a', 'b', 'a', 'b']
    assert after_failure == {'a_result': 'a answer'}
    assert saved == {'a_result': 'a answer', 'b_result': 'b answer'}
    assert [event.node_info.path for event in message_events(retried)] == ['wf@1/a@1', 'wf@1/b@1']


def test_native_confirming_node_stops_before_the_write_body():
    observed = ledger()
    flow = Workflow(name='wf', edges=[('START', leaf('b', observed, writes=True, pause=True))])

    async def measure():
        runner = await start(flow)
        try:
            return await collect(runner, 'ask before writing'), await state(runner)
        finally:
            await runner.close()

    events, saved = asyncio.run(measure())
    assert observed['bodies'] == []
    assert [name for name, _ in observed['requests']] == ['b']
    assert any(call.name == 'adk_request_confirmation' for event in events for call in event.get_function_calls())
    assert any(event.long_running_tool_ids for event in events)
    assert saved == {}
