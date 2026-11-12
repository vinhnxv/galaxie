# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Executor evidence and the author-owned message attribution recipe.

Gate | Observed | Result
GA3 | Accepted duplicate leaves emit the same author and no ancestry | FAIL
GA1/GA2/GA4-GA8 | Not measured: support outcome fixed by GA3 | unmeasured
AL1 | Real message events map to hand-written paths for five unique-name trees | PASS
AL2 | Existing on_stream callback only, no runtime/bridge/storage changes | PASS
AL3 | Messages only; duplicate names ambiguous; Parallel interleaves | documented limit
GF2 | A is ALTERNATIVE, so the flag cannot become true | FAIL

GA2 would only be implementation consistency with the tree oracle, not an
independent namespace parity oracle. No test-local path patch is needed after
the decisive GA3 failure. The recipe does not manufacture paths for markers.
"""

import asyncio
import json

import pytest
from google.adk.agents import LlmAgent, LoopAgent, ParallelAgent, SequentialAgent

from galaxie import GalaxieError, _bridge
from galaxie.adk import Executor, llm


def leaf(name):
    return LlmAgent(name=name, model=llm(name))


def tree(shape):
    if shape == 'sequential':
        return SequentialAgent(name='root', sub_agents=[leaf('drafter'), leaf('reviewer')])
    if shape == 'parallel':
        return ParallelAgent(name='root', sub_agents=[leaf('left'), leaf('right')])
    if shape == 'nested':
        return ParallelAgent(name='root', sub_agents=[
            SequentialAgent(name='sequence', sub_agents=[leaf('a'), leaf('b')]), leaf('c'),
        ])
    if shape == 'loop':
        return LoopAgent(name='root', max_iterations=2, sub_agents=[leaf('worker')])
    if shape == 'transfer':
        return LlmAgent(name='root', model=llm('root'), sub_agents=[leaf('specialist')])
    if shape == 'duplicate':
        return SequentialAgent(name='root', sub_agents=[
            SequentialAgent(name='first', sub_agents=[leaf('worker')]),
            SequentialAgent(name='second', sub_agents=[leaf('worker')]),
        ])
    raise AssertionError(shape)


def author_paths(root):
    """Author-owned lookup: keep all candidates, never silently pick a duplicate."""
    result = {}

    def visit(agent, path):
        result.setdefault(agent.name, []).append(path)
        for child in agent.sub_agents:
            visit(child, [*path, child.name])

    visit(root, [])
    return result


def measure(root, reverse=False):
    async def transport(raw):
        message = json.loads(raw)
        assert message['op'] == 'model'
        role = message['payload']['role']
        if role == 'root':
            reply = {'content': '', 'toolCalls': [{'id': 'transfer', 'type': 'function', 'function': {
                'name': 'transfer_to_agent', 'arguments': '{"agent_name":"specialist"}',
            }}]}
        else:
            if role == ('left' if reverse else 'right'):
                await asyncio.sleep(0.01)
            reply = {'content': role}
            _bridge.receive_model_chunk(json.dumps({
                **message, 'kind': 'notify', 'op': 'model-chunk', 'payload': reply,
            }))
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})

    _bridge.install_transport(transport)
    events = []
    executor = Executor(root)
    asyncio.run(executor.run({'prompt': 'go'}, 's1', 10, on_stream=lambda mode, data: events.append((mode, data))))
    return events


@pytest.mark.parametrize(('shape', 'expected'), [
    ('sequential', [['drafter'], ['reviewer']]),
    ('parallel', [['left'], ['right']]),
    ('nested', [['sequence', 'a'], ['sequence', 'b'], ['c']]),
    ('loop', [['worker'], ['worker']]),
    ('transfer', [['specialist']]),
])
def test_author_recipe_reproduces_the_native_tree_oracle_for_messages(shape, expected):
    root = tree(shape)
    paths = author_paths(root)
    messages = [data for mode, data in measure(root) if mode == 'messages']
    assert sorted(paths[data['author']][0] for data in messages) == sorted(expected)
    assert all(len(paths[data['author']]) == 1 for data in messages)


def test_duplicate_names_fail_unsupported_at_prepare_without_a_model_call():
    root = tree('duplicate')
    assert author_paths(root)['worker'] == [['first', 'worker'], ['second', 'worker']]
    requests = []

    async def transport(raw):
        requests.append(raw)
        raise AssertionError('Prepare must not reach the bridge.')

    _bridge.install_transport(transport)
    with pytest.raises(GalaxieError) as error:
        Executor(root)
    assert error.value.code == 'unsupported'
    assert requests == []


def test_reversed_parallel_arrival_keeps_the_recipe_paths():
    runs = [measure(tree('parallel'), reverse) for reverse in (False, True)]
    assert [[data['author'] for mode, data in events if mode == 'messages'] for events in runs] == [
        ['left', 'right'], ['right', 'left'],
    ]


def test_non_ascii_names_still_prepare_and_the_recipe_keeps_the_name():
    root = leaf('écrivain')
    assert measure(root) == [('messages', {'author': 'écrivain', 'text': 'écrivain'})]
    assert author_paths(root) == {'écrivain': [[]]}
