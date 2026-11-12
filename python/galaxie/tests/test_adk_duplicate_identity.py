# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""DA1 FAIL: native Sequential/Loop fields collide.
DA2 FAIL S5: partial-only first worker is missing from the stored log;
DC1 attributes second/first/second to first/second/first.
S1-S3 and ordinary two-turn baseline PASS; S6-S8 not measured: fixed by S5.
DA3 PASS S4: rebuilt pause log and live derivation agree.
DA4: first-match output key loses structured output; Python additionally
mixes Parallel surrogate buffers. Native transfer prediction did not hold.
D-py REFUSED: the prepare-time refusal ships after the recorded DA failure.
RF1-RF8 PASS: exact-name refusal, unchanged unique-name restore bytes,
zero model/store requests, limit trees and unchanged control boundaries.
GA1-GA5/GA7 PASS test-locally; GA3 follows unique accepted names.
GA6/GA8 not measured: carriage not shipped; GF1-GF5 fixed by GF2.
No public path, stored format or effect scope changes.
"""

import asyncio
import json

import pytest
from google.adk.agents import BaseAgent, LlmAgent, LoopAgent, ParallelAgent, SequentialAgent
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


def tree(shape='sequential', tools=False, pause=False, output=False):
    def leaf(name, role):
        extras = {'output_key': f'{role}_key', 'output_schema': Output} if output else {}
        tool = capability_tool('echo', 'test.echo@1', {'type': 'object', 'properties': {}}, 'Echo.', require_confirmation=role == 'gate')
        model = llm(role)
        return LlmAgent(name=name, model=model, tools=[tool] if tools or role == 'gate' else [], **extras)

    if shape == 'unique-sequential':
        return SequentialAgent(name='root', sub_agents=[leaf('drafter', 'drafter'), leaf('reviewer', 'reviewer')])
    if shape == 'unique-parallel':
        return ParallelAgent(name='root', sub_agents=[leaf('left', 'left'), leaf('right', 'right')])
    if shape == 'unique-nested':
        return ParallelAgent(name='root', sub_agents=[SequentialAgent(name='sequence', sub_agents=[leaf('a', 'a'), leaf('b', 'b')]), leaf('c', 'c')])
    if shape == 'unique-loop':
        return LoopAgent(name='root', max_iterations=2, sub_agents=[leaf('worker', 'worker')])
    if shape == 'unique-transfer':
        return LlmAgent(name='root', model=llm('router'), sub_agents=[leaf('specialist', 'specialist')])
    if shape == 'unique-pause':
        return SequentialAgent(name='root', sub_agents=[leaf('head', 'head'), leaf('gate', 'gate')])
    branches: list[BaseAgent] = [SequentialAgent(name=name, sub_agents=[leaf('specialist' if shape == 'transfer' else 'worker', name)]) for name in ('first', 'second')]
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


@pytest.mark.parametrize(('shape', 'oracle'), [
    ('unique-sequential', [['drafter'], ['reviewer']]),
    ('unique-parallel', [['left'], ['right']]),
    ('unique-nested', [['sequence', 'a'], ['sequence', 'b'], ['c']]),
    ('unique-loop', [['worker'], ['worker']]),
    ('unique-transfer', [['specialist']]),
])
def test_namespace_recipe_is_deterministic_content_free_and_uses_no_stored_field(shape, oracle):
    for _ in range(2):
        install()
        root = tree(shape)
        executor = Executor(root)
        executor.durable = True
        for turn in range(2):
            _, events = run(executor)
            assert sorted(derive([event for event in stored(executor) if event.is_final_response()], root)) == sorted(oracle * (turn + 1))
            for mode, data in events:
                if mode == 'messages':
                    positions = paths_of(root)[data['author']]
                    assert len(positions) == 1
                    assert len(positions[0]) <= 16
                    assert 'content-canary' not in json.dumps(positions)


@pytest.mark.parametrize('shape', ['sequential', 'parallel', 'loop', 'transfer', 'root-duplicate', 'shared', 'tools', 'output', 'pause'])
def test_duplicates_fail_at_prepare_before_model_or_store_requests(shape):
    requests = install()
    root = tree(shape, tools=shape == 'tools', output=shape == 'output', pause=shape == 'pause')
    if shape == 'root-duplicate':
        root = SequentialAgent(name='worker', sub_agents=[LlmAgent(name='worker', model=llm('first'))])
    if shape == 'shared':
        shared = root.sub_agents[0].sub_agents[0]
        object.__setattr__(root.sub_agents[1], 'sub_agents', [shared])
    with pytest.raises(GalaxieError) as error:
        Executor(root)
    assert error.value.code == 'unsupported'
    assert str(error.value) == 'This operation is unsupported.'
    assert requests == []


def test_duplicate_does_not_hide_a_later_invalid_child():
    requests = install()
    root = tree()
    bad = LlmAgent(name='bad', model=llm('bad'))
    object.__setattr__(bad, 'sub_agents', {})
    root.sub_agents.append(bad)
    with pytest.raises(GalaxieError) as error:
        Executor(root)
    assert error.value.code == 'invalid'
    assert requests == []


@pytest.mark.parametrize('shape', ['distinct', 'depth-limit', 'size-limit'])
def test_exact_distinct_names_and_limit_trees_prepare_and_run(shape):
    requests = install()
    if shape == 'distinct':
        root = SequentialAgent(name='root', sub_agents=[LlmAgent(name=name, model=llm(f'name{index}')) for index, name in enumerate(['Worker', 'worker', '\u00e9', 'e\u0301'])])
    elif shape == 'size-limit':
        root = SequentialAgent(name='root', sub_agents=[LlmAgent(name=f'leaf{index}', model=llm(f'leaf{index}')) for index in range(255)])
    else:
        root = LlmAgent(name='bottom', model=llm('bottom'))
        for depth in reversed(range(16)):
            root = SequentialAgent(name=f'level{depth}', sub_agents=[root])
    assert all(len(positions) == 1 for positions in paths_of(root).values())
    assert asyncio.run(Executor(root).run({'prompt': 'go'}, 's1', 300, on_stream=lambda *_: None)) is not None
    assert len(requests) == (255 if shape == 'size-limit' else 4 if shape == 'distinct' else 1)


def test_unique_pause_bytes_restore_unchanged_and_duplicate_prepare_never_reads_them():
    requests = install()
    original = Executor(tree('unique-pause'), interaction=interaction)
    original.durable = True
    assert run(original)[0] is None
    checkpoint, metadata = original._snapshot('s1', 'bound')
    other = Executor(tree('unique-pause'), interaction=interaction)
    other.durable = True
    assert asyncio.run(other._restore(checkpoint, metadata, 'bound')) == 's1'
    assert other._snapshot('s1', 'bound') == (checkpoint, metadata)
    pending = other.pending('s1')
    assert pending is not None
    assert pending == original.pending('s1')
    assert run(other, {'interactionId': pending['id'], 'action': 'approve', 'payload': {'indexes': [0]}})[0] == 'gate'
    before = list(requests)
    with pytest.raises(GalaxieError) as error:
        Executor(tree(pause=True), interaction=interaction)
    assert error.value.code == 'unsupported'
    assert requests == before
    assert original._snapshot('s1', 'bound') == (checkpoint, metadata)
