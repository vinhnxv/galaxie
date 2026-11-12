# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native Workflow facts for the stream namespace spike (scripted models).

Gate | Observed | Result
NW1 | chain, fan-out/join, route, cycle, retry, write and pause run | measured
NW1 | revisits increment run IDs; local retries reuse the same node path | prediction contradicted
NW2 | Runner(node=...) supports the adapter session service and plugins | entry seam available

Fan-out branches are b@1/c@1, contrary to the shared-branch prediction.
The scope gate must still measure re-dispatch, not infer it from these paths.
"""

import asyncio

from google.adk.agents import LlmAgent
from google.adk.agents.context import Context
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.adk.tools import FunctionTool
from google.adk.workflow import FunctionNode, JoinNode, RetryConfig, Workflow
from google.genai import types

REQUESTS: list[str] = []
BODIES: list[int] = []


class Scripted(BaseLlm):
    replies: list
    delay: bool = False

    async def generate_content_async(self, llm_request, stream=False):
        REQUESTS.append(self.model)
        if self.delay:
            await asyncio.sleep(0.01)
        reply = self.replies.pop(0)
        part = types.Part(text=reply) if isinstance(reply, str) else types.Part(
            function_call=types.FunctionCall(name='write', args={'value': reply}),
        )
        yield LlmResponse(content=types.Content(role='model', parts=[part]), turn_complete=True)


def write(value: int) -> dict:
    """Record a scripted write body."""
    BODIES.append(value)
    return {'value': value}


def leaf(name, *, writes=False, pause=False, delay=False):
    return LlmAgent(name=name, model=Scripted(model=name, replies=[1, name] if writes else [name], delay=delay),
                    tools=[FunctionTool(write, require_confirmation=pause)] if writes else [])


async def collect(flow):
    runner = InMemoryRunner(node=flow, app_name='workflow')
    await runner.session_service.create_session(app_name='workflow', user_id='user', session_id='session')
    return [event async for event in runner.run_async(
        user_id='user', session_id='session', new_message=types.Content(role='user', parts=[types.Part(text='go')]),
    )]


def texts(events):
    return [(event.author, ''.join(part.text or '' for part in event.content.parts or []))
            for event in events if event.content and any(part.text for part in event.content.parts or [])]


def test_native_chain_has_run_numbered_paths_but_no_branch():
    REQUESTS.clear()
    a, b = leaf('a'), leaf('b')
    events = asyncio.run(collect(Workflow(name='wf', edges=[('START', a, b)])))
    assert texts(events) == [('a', 'a'), ('b', 'b')]
    assert REQUESTS == ['a', 'b']
    authored = [event for event in events if event.content]
    assert [(event.author, event.branch, event.node_info.path) for event in authored] == [
        ('a', None, 'wf@1/a@1'), ('b', None, 'wf@1/b@1'),
    ]


def test_native_fanout_write_events_get_run_numbered_branches():
    for reverse in (False, True):
        REQUESTS.clear()
        BODIES.clear()
        a, b, c = leaf('a'), leaf('b', writes=True, delay=reverse), leaf('c', writes=True, delay=not reverse)
        flow = Workflow(name='wf', edges=[('START', a, (b, c), JoinNode(name='join'))])
        events = asyncio.run(collect(flow))
        calls = [event for event in events if event.get_function_calls()]
        assert [event.author for event in calls] == (['b', 'c'] if not reverse else ['c', 'b'])
        # Unlike the prediction, fan-out forks branches even with an LlmAgent node.
        assert [event.branch for event in calls] == (['b@1', 'c@1'] if not reverse else ['c@1', 'b@1'])
        assert {event.node_info.path for event in calls} == {'wf@1/b@1', 'wf@1/c@1'}
        assert sorted(REQUESTS) == ['a', 'b', 'b', 'c', 'c']
        assert BODIES == [1, 1]


def test_native_route_selects_only_the_named_edge():
    REQUESTS.clear()

    def route(ctx: Context):
        ctx.route = 'yes'
        return 'chosen'

    choose = FunctionNode(name='choose', func=route)
    flow = Workflow(name='wf', edges=[('START', choose, {'yes': leaf('b'), 'no': leaf('c')})])
    events = asyncio.run(collect(flow))
    assert texts(events) == [('b', 'b')]
    assert REQUESTS == ['b']


def test_native_cycle_gets_a_new_run_path_but_local_retry_reuses_its_path():
    visits = []

    def cycle(ctx: Context):
        visits.append(ctx.node_path)
        ctx.route = 'again' if len(visits) == 1 else 'stop'
        return 'visited'

    step = FunctionNode(name='step', func=cycle)
    events = asyncio.run(collect(Workflow(name='wf', edges=[('START', step), (step, {'again': step})])))
    assert visits == ['wf@1/step@1', 'wf@1/step@2']
    assert {event.node_info.path for event in events if event.node_info.path.startswith('wf@1/step@')} == set(visits)
    attempts = []

    def retry(ctx: Context):
        attempts.append(ctx.node_path)
        if len(attempts) == 1:
            raise ValueError('scripted first attempt')
        return 'retried'

    node = FunctionNode(name='retry', func=retry, retry_config=RetryConfig(max_attempts=2, initial_delay=0, jitter=0))
    asyncio.run(collect(Workflow(name='wf', edges=[('START', node)])))
    # A local retry is the same visit, contrary to the registered new-run-ID prediction.
    assert attempts == ['wf@1/retry@1', 'wf@1/retry@1']


def test_native_write_runs_once_and_a_confirmation_stops_before_its_body():
    BODIES.clear()
    REQUESTS.clear()
    events = asyncio.run(collect(Workflow(name='wf', edges=[('START', leaf('writer', writes=True))])))
    assert texts(events) == [('writer', 'writer')]
    assert REQUESTS == ['writer', 'writer']
    assert BODIES == [1]
    BODIES.clear()
    events = asyncio.run(collect(Workflow(name='wf', edges=[('START', leaf('writer', writes=True, pause=True))])))
    assert BODIES == []
    assert any(call.name == 'adk_request_confirmation' for event in events for call in event.get_function_calls())
