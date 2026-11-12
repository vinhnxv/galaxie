# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native ADK 2.12.0 stream identity, independent of galaxie.

NA1: tree-authored expectations below pin authors and Parallel-only branches.
NA2: Sequential, Loop and transfer events do not have distinct branches.
GA3 consequence: duplicate authors in separate Sequential subtrees have the
same branch; author plus branch cannot recover their distinct tree positions.
"""

import asyncio

import pytest
from google.adk.agents import LlmAgent, LoopAgent, ParallelAgent, SequentialAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.genai import types


class Scripted(BaseLlm):
    replies: list
    delay: bool = False

    async def generate_content_async(self, llm_request, stream=False):
        if self.delay:
            await asyncio.sleep(0.01)
        reply = self.replies.pop(0)
        part = types.Part(text=reply) if isinstance(reply, str) else types.Part(
            function_call=types.FunctionCall(name=reply[0], args=reply[1]),
        )
        yield LlmResponse(content=types.Content(role='model', parts=[part]), turn_complete=True)


def leaf(name, replies=None, **options):
    return LlmAgent(name=name, model=Scripted(model=name, replies=replies or [name], **options))


def tree(shape, reverse=False):
    if shape == 'sequential':
        return SequentialAgent(name='root', sub_agents=[leaf('drafter'), leaf('reviewer')])
    if shape == 'parallel':
        return ParallelAgent(name='root', sub_agents=[leaf('left', delay=reverse), leaf('right', delay=not reverse)])
    if shape == 'nested':
        return ParallelAgent(name='root', sub_agents=[
            SequentialAgent(name='sequence', sub_agents=[leaf('a'), leaf('b')]), leaf('c'),
        ])
    if shape == 'loop':
        return LoopAgent(name='root', max_iterations=2, sub_agents=[leaf('worker', ['one', 'two'])])
    if shape == 'transfer':
        return LlmAgent(name='root', model=Scripted(model='root', replies=[
            ('transfer_to_agent', {'agent_name': 'specialist'}),
        ]), sub_agents=[leaf('specialist')])
    if shape == 'duplicate':
        return SequentialAgent(name='root', sub_agents=[
            SequentialAgent(name='first', sub_agents=[leaf('worker')]),
            SequentialAgent(name='second', sub_agents=[leaf('worker')]),
        ])
    raise AssertionError(shape)


# Hand-written tree oracle, created before any galaxie measurement.
ORACLE = {
    'sequential': [('drafter', '', ['drafter']), ('reviewer', '', ['reviewer'])],
    'parallel': [('left', 'root.left', ['left']), ('right', 'root.right', ['right'])],
    'nested': [('a', 'root.sequence', ['sequence', 'a']), ('b', 'root.sequence', ['sequence', 'b']), ('c', 'root.c', ['c'])],
    'loop': [('worker', '', ['worker']), ('worker', '', ['worker'])],
    'transfer': [('root', '', []), ('specialist', '', ['specialist'])],
    'duplicate': [('worker', '', ['first', 'worker']), ('worker', '', ['second', 'worker'])],
}


async def collect(root):
    runner = InMemoryRunner(agent=root, app_name='identity')
    await runner.session_service.create_session(app_name='identity', user_id='user', session_id='session')
    return [event async for event in runner.run_async(
        user_id='user', session_id='session', new_message=types.Content(role='user', parts=[types.Part(text='go')]),
    )]


@pytest.mark.parametrize('shape', list(ORACLE))
def test_native_authors_and_branches_follow_the_tree_oracle(shape):
    events = asyncio.run(collect(tree(shape)))
    authored = [event for event in events if event.content and event.content.role == 'model']
    actual = [(event.author, event.branch or '') for event in authored]
    expected = [(author, branch) for author, branch, _ in ORACLE[shape]]
    assert sorted(actual) == sorted(expected)
    if shape not in ('transfer',):
        assert [event.node_info.path for event in authored] == [''] * len(authored)
    if shape == 'duplicate':
        assert actual == [('worker', ''), ('worker', '')]
        assert ORACLE[shape][0][2] != ORACLE[shape][1][2]


def test_parallel_reverses_arrival_without_changing_identity():
    runs = [asyncio.run(collect(tree('parallel', reverse))) for reverse in (False, True)]
    authors = [[event.author for event in events if event.content] for events in runs]
    assert authors == [['left', 'right'], ['right', 'left']]
    assert sorted((event.author, event.branch) for event in runs[0]) == sorted(
        (event.author, event.branch) for event in runs[1])


def test_native_python_accepts_a_non_ascii_identifier():
    events = asyncio.run(collect(leaf('écrivain')))
    assert [event.author for event in events if event.content] == ['écrivain']
