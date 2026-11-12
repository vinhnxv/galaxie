# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native duplicate identity: DA1 fails on Sequential/Loop; Parallel separates.

DA4 records first-match find_agent; transfer through Sequential wrappers raises.
Root-name reuse and sibling duplicates are accepted; shared parents are refused.
Case and Unicode normalization distinguish names exactly.
"""

import asyncio

import pytest
from google.adk.agents import LlmAgent, LoopAgent, ParallelAgent, SequentialAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.genai import types


class Scripted(BaseLlm):
    calls: list
    delay: bool = False

    async def generate_content_async(self, llm_request, stream=False):
        self.calls.append(self.model)
        if self.delay:
            await asyncio.sleep(0.01)
        part = types.Part(function_call=types.FunctionCall(name='transfer_to_agent', args={'agent_name': 'specialist'})) if self.model == 'router' else types.Part(text=self.model)
        yield LlmResponse(content=types.Content(role='model', parts=[part]), turn_complete=True)


def tree(shape, reverse=False):
    def leaf(name, position, delay=False):
        return LlmAgent(name=name, model=Scripted(model=position, calls=[], delay=delay))

    name = 'specialist' if shape == 'transfer' else 'worker'
    branches = [SequentialAgent(name=parent, sub_agents=[leaf(name, parent, reverse != second)])
                for second, parent in enumerate(('first', 'second'))]
    if shape == 'parallel':
        return ParallelAgent(name='root', sub_agents=branches)
    if shape == 'loop':
        return LoopAgent(name='root', sub_agents=branches, max_iterations=2)
    if shape == 'transfer':
        return LlmAgent(name='root', model=Scripted(model='router', calls=[]), sub_agents=branches)
    return SequentialAgent(name='root', sub_agents=branches)


async def collect(root):
    runner = InMemoryRunner(agent=root, app_name='identity')
    session = await runner.session_service.create_session(app_name='identity', user_id='user')
    return [event async for event in runner.run_async(user_id='user', session_id=session.id,
        new_message=types.Content(role='user', parts=[types.Part(text='go')])) if event.content and event.content.role == 'model']


@pytest.mark.parametrize(('shape', 'expected'), [
    ('sequential', [('worker', '', False, True)] * 2),
    ('parallel', [('worker', 'root.first', False, True), ('worker', 'root.second', False, True)]),
    ('loop', [('worker', '', False, True)] * 4),
])
def test_native_duplicate_identity_fields(shape, expected):
    events = asyncio.run(collect(tree(shape)))
    assert sorted((e.author, e.branch or '', bool(e.partial), e.is_final_response()) for e in events) == sorted(expected)
    assert len({e.invocation_id for e in events}) == 1
    assert [e.node_info.path for e in events] == [''] * len(events)


def test_native_parallel_identity_survives_reversed_arrival():
    runs = [asyncio.run(collect(tree('parallel', reverse))) for reverse in (False, True)]
    assert [[(e.content.parts[0].text, e.branch) for e in events] for events in runs] == [
        [('first', 'root.first'), ('second', 'root.second')],
        [('second', 'root.second'), ('first', 'root.first')],
    ]


def test_native_find_agent_chooses_first_match_but_transfer_refuses_unrelated_leaf():
    root = tree('transfer')
    first, second = [child.sub_agents[0] for child in root.sub_agents]
    assert root.find_agent('specialist') is first
    with pytest.raises(ValueError, match="Cannot transfer from 'root' to unrelated agent 'specialist'"):
        asyncio.run(collect(root))
    assert root.model.calls == ['router']
    assert first.model.calls == []
    assert second.model.calls == []


def test_native_root_name_reuse_and_exact_distinct_names():
    root = SequentialAgent(name='worker', sub_agents=[LlmAgent(name='worker', model=Scripted(model='child', calls=[]))])
    assert [e.author for e in asyncio.run(collect(root))] == ['worker']
    names = ['Worker', 'worker', '\u00e9', 'e\u0301']
    root = SequentialAgent(name='root', sub_agents=[LlmAgent(name=name, model=Scripted(model=name, calls=[])) for name in names])
    assert [e.author for e in asyncio.run(collect(root))] == names


def test_native_shared_instance_is_refused_but_sibling_duplicates_only_warn(caplog):
    shared = LlmAgent(name='worker', model=Scripted(model='shared', calls=[]))
    SequentialAgent(name='first', sub_agents=[shared])
    with pytest.raises(ValueError, match='parent'):
        SequentialAgent(name='second', sub_agents=[shared])
    siblings = SequentialAgent(name='root', sub_agents=[LlmAgent(name='worker'), LlmAgent(name='worker')])
    assert len(siblings.sub_agents) == 2
    assert 'Found duplicate sub-agent names' in caplog.text
