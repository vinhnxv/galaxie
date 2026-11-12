# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""DA1 FAIL: native Sequential/Loop fields collide.
DA2 FAIL S5: partial-only first worker is missing from the stored log;
DC1 attributes second/first/second to first/second/first.
S1-S3 and ordinary two-turn baseline PASS; S6-S8 not measured: fixed by S5.
DA3 PASS S4: rebuilt pause log and live derivation agree.
DA4: first-match output key loses structured output; Python additionally
mixes Parallel surrogate buffers. Native transfer prediction did not hold.
D-js/D-py select the refusal candidate, conditional on RF1-RF8 and shipping.
RF1 census PASS; RF2-RF8 pending shipped candidate verification.
GA6/GA8 not measured: carriage not shipped; GF1-GF5 fixed by GF2.
No public path, stored format or effect scope changes.
"""

import asyncio
import json

import pytest
from google.adk.agents import LlmAgent, LoopAgent, ParallelAgent, SequentialAgent
from google.adk.events import Event
from pydantic import BaseModel

from galaxie import GalaxieError, _bridge
from galaxie.adk import Executor, capability_tool, llm


def paths_of(root):
    result = {}

    def visit(agent, path):
        result.setdefault(agent.name, []).append(path)
        for child in agent.sub_agents:
            visit(child, [*path, child.name])

    visit(root, [])
    return result


def derive(events, root):
    """Registered DC1 counts final responses per name and branch over the log."""
    counts, result = {}, []
    paths = paths_of(root)
    for event in events:
        if event.content is None or event.content.role != 'model':
            continue
        positions = paths[event.author]
        if event.branch:
            positions = [path for path in positions if event.branch == f'root.{path[0]}']
        key = (event.author, event.branch)
        count = counts.get(key, 0)
        result.append(positions[count % len(positions)])
        if not event.partial and event.is_final_response():
            counts[key] = count + 1
    return result


class Output(BaseModel):
    position: str


def tree(shape='sequential', tools=False, pause=False, output=False, partial_only=False):
    def leaf(name, role):
        extras = {'output_key': f'{role}_key', 'output_schema': Output} if output else {}
        tool = capability_tool('echo', 'test.echo@1', {'type': 'object', 'properties': {}}, 'Echo.', require_confirmation=role == 'gate')
        model = llm(role)
        if partial_only and role == 'first':
            generate = model.generate_content_async
            omitted = False

            async def partial(request, stream=False):
                nonlocal omitted
                drop = not omitted
                async for response in generate(request, stream):
                    if not drop or response.partial:
                        yield response
                omitted = True

            object.__setattr__(model, 'generate_content_async', partial)
        return LlmAgent(name=name, model=model, tools=[tool] if tools or role == 'gate' else [], **extras)

    branches = [SequentialAgent(name=name, sub_agents=[leaf('specialist' if shape == 'transfer' else 'worker', name)]) for name in ('first', 'second')]
    if shape == 'loop':
        return LoopAgent(name='root', max_iterations=2, sub_agents=branches)
    if shape == 'parallel':
        return ParallelAgent(name='root', sub_agents=branches)
    if shape == 'transfer':
        return LlmAgent(name='root', model=llm('router'), sub_agents=branches)
    return SequentialAgent(name='root', sub_agents=[*branches, leaf('gate', 'gate')] if pause else branches)


def interaction(requests):
    return {'surfaceId': 'main', 'viewRevision': 'r1', 'component': 'tests.Approval/v1', 'props': {}}


def install(tools=False, output=False):
    requests, turns = [], {}

    async def transport(raw):
        message = json.loads(raw)
        requests.append((message['op'], message['payload']))
        if message['op'] == 'capability':
            reply = {'text': 'content-canary'}
        else:
            assert message['op'] == 'model'
            role = message['payload']['role']
            turn = turns.get(role, 0)
            turns[role] = turn + 1
            if (tools or role == 'gate' or role == 'router') and turn == 0:
                reply = {'content': '', 'toolCalls': [{'id': f'call-{role}', 'type': 'function', 'function': {
                    'name': 'transfer_to_agent' if role == 'router' else 'echo',
                    'arguments': '{"agent_name":"specialist"}' if role == 'router' else '{}',
                }}]}
            else:
                reply = {'content': json.dumps({'position': role}) if output else role}
                _bridge.receive_model_chunk(json.dumps({**message, 'kind': 'notify', 'op': 'model-chunk', 'payload': reply}))
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})

    _bridge.install_transport(transport)
    return requests


def run(executor, resume=None):
    events = []
    result = asyncio.run(executor.run({'prompt': 'content-canary'}, 's1', 30, on_stream=lambda mode, data: events.append((mode, data)), resume=resume))
    return result, events


def stored(executor):
    checkpoint, _ = executor._snapshot('s1', 'bound')
    return [Event.model_validate(event) for event in json.loads(checkpoint)['events']]


@pytest.mark.parametrize(('script', 'shape', 'tools', 'oracle'), [
    ('S1', 'sequential', False, [['first', 'worker'], ['second', 'worker']]),
    ('S2', 'sequential', True, [['first', 'worker']] * 2 + [['second', 'worker']] * 2),
    ('S3', 'loop', False, [['first', 'worker'], ['second', 'worker']] * 2),
])
def test_dc1_matches_authored_oracle(script, shape, tools, oracle):
    install(tools=tools)
    root = tree(shape, tools=tools)
    executor = Executor(root)
    executor.durable = True
    run(executor)
    assert derive(stored(executor), root) == oracle


def test_s5_two_user_turns():
    requests = install()
    root = tree()
    executor = Executor(root)
    executor.durable = True
    run(executor)
    run(executor)
    assert [payload['role'] for op, payload in requests if op == 'model'] == ['first', 'second', 'first', 'second']
    assert derive(stored(executor), root) == [['first', 'worker'], ['second', 'worker']] * 2


def test_s4_da3_pause_restores_the_live_derivation():
    install()
    root = tree(pause=True)
    original = Executor(root, interaction=interaction)
    original.durable = True
    assert run(original)[0] is None
    checkpoint, metadata = original._snapshot('s1', 'bound')
    before = derive(stored(original), root)
    rebuilt = tree(pause=True)
    other = Executor(rebuilt, interaction=interaction)
    other.durable = True
    assert asyncio.run(other._restore(checkpoint, metadata, 'bound')) == 's1'
    assert other._snapshot('s1', 'bound') == (checkpoint, metadata)
    assert derive(stored(other), rebuilt) == before
    pending = other.pending('s1')
    assert pending == original.pending('s1')
    assert run(other, {'interactionId': pending['id'], 'action': 'approve', 'payload': {'indexes': [0]}})[0] == 'gate'


def test_da4_output_key_uses_first_agent_and_loses_structured_value():
    install(output=True)
    executor = Executor(tree(output=True))
    assert run(executor)[0] == '{"position": "second"}'


def test_s5_partial_only_worker_makes_stored_log_dc1_choose_wrong_position():
    requests = install()
    root = tree(partial_only=True)
    executor = Executor(root)
    executor.durable = True
    run(executor)
    run(executor)
    oracle = [['second', 'worker'], ['first', 'worker'], ['second', 'worker']]
    observed = derive(stored(executor), root)
    assert observed == [['first', 'worker'], ['second', 'worker'], ['first', 'worker']]
    assert observed != oracle
    assert [payload['role'] for op, payload in requests if op == 'model'] == ['first', 'second', 'first', 'second']


def test_da4_parallel_duplicates_mix_surrogate_buffers():
    async def go():
        left_started, right_done = asyncio.Event(), asyncio.Event()
        events = []

        async def transport(raw):
            message = json.loads(raw)

            def chunk(text):
                _bridge.receive_model_chunk(json.dumps({**message, 'kind': 'notify', 'op': 'model-chunk', 'payload': {'content': text}}))

            if message['payload']['role'] == 'first':
                chunk('x\ud83d')
                await right_done.wait()
                await asyncio.sleep(0.01)
                chunk('\ude00')
                reply = {'content': 'x\U0001f600'}
            else:
                await left_started.wait()
                chunk('y')
                reply = {'content': 'y'}
            return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})

        def stream(mode, data):
            if mode == 'messages':
                events.append(data['text'])
                if data['text'] == 'x':
                    left_started.set()
                if 'y' in data['text']:
                    right_done.set()

        _bridge.install_transport(transport)
        await Executor(tree('parallel')).run({'prompt': 'go'}, 's1', 10, on_stream=stream)
        return events

    assert asyncio.run(go()) == ['x', '\ud83dy', '\ude00']
