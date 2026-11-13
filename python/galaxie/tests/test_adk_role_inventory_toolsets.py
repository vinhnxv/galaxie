# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
from typing import Any, cast

import pytest
from google.adk.agents import LlmAgent, LoopAgent, ParallelAgent, SequentialAgent
from google.adk.tools import FunctionTool
from google.adk.tools.base_toolset import BaseToolset
from google.adk.tools.openapi_tool.openapi_spec_parser.openapi_toolset import OpenAPIToolset

from galaxie import GalaxieError, _bridge
from galaxie import adk as face
from galaxie.adk import Executor, capability_tool, llm, loop_exit


def tool(name='double', **options):
    return capability_tool(name, 'math.double@1', {
        'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value'],
    }, 'Double an integer.', **options)


def test_fixed_toolset_freezes_its_members_and_returns_fresh_lists():
    first, second = tool(), tool('other')
    members = [first, second]
    group = face.toolset(members)
    members.clear()
    one = asyncio.run(group.get_tools())
    two = asyncio.run(group.get_tools())
    assert one == two == [first, second]
    assert one is not two
    listed = asyncio.run(group.get_tools_with_prefix())
    listed.clear()
    assert asyncio.run(group.get_tools_with_prefix()) == [first, second]
    asyncio.run(group.close())
    assert asyncio.run(group.get_tools()) == [first, second]
    assert Executor(LlmAgent(name='root', model=llm('answer'), tools=[group]))


def unsupported(call):
    with pytest.raises(GalaxieError) as error:
        call()
    assert error.value.code == 'unsupported'


class ForeignToolset(BaseToolset):
    async def get_tools(self, readonly_context=None):
        raise AssertionError('Refused toolsets must not be expanded.')

    async def close(self):
        pass


@pytest.mark.parametrize('kind', ['empty', 'duplicate', 'foreign-tool', 'nested', 'exit'])
def test_the_helper_refuses_unregistered_or_ambiguous_members(kind):
    members = {
        'empty': [], 'duplicate': [tool(), tool()],
        'foreign-tool': [FunctionTool(lambda: {})],
        'nested': [face.toolset([tool()])], 'exit': [loop_exit()],
    }[kind]
    unsupported(lambda: face.toolset(members))


def test_non_list_inputs_are_invalid():
    for value in (None, {}, (), 'tools'):
        with pytest.raises(GalaxieError) as error:
            face.toolset(cast(Any, value))
        assert error.value.code == 'invalid'


@pytest.mark.parametrize('kind', ['foreign-tools', 'foreign-toolset', 'author', 'openapi'])
def test_foreign_and_dynamic_toolsets_refuse_without_listing_or_requests(monkeypatch, kind):
    group = face.toolset([tool()])
    if kind == 'foreign-tools':
        monkeypatch.setattr(face, '_tools', face._Registry())
    elif kind == 'foreign-toolset':
        monkeypatch.setattr(face, '_toolsets', face._Registry())
    elif kind == 'author':
        group = ForeignToolset()
    elif kind == 'openapi':
        group = object.__new__(OpenAPIToolset)
    seen = []

    async def transport(raw):
        seen.append(raw)
        raise AssertionError('Prepare must not dispatch.')

    _bridge.install_transport(transport)
    unsupported(lambda: Executor(LlmAgent(name='root', model=llm('answer'), tools=[group])))
    assert seen == []


@pytest.mark.parametrize('name,value', [
    ('tool_filter', lambda *args: True), ('tool_name_prefix', 'prefix'),
    ('_members', ()), ('get_tools', lambda *args: []), ('_use_invocation_cache', False),
])
def test_fixed_toolsets_refuse_changes_to_their_listing_behavior(name, value):
    group = face.toolset([tool()])
    unsupported(lambda: setattr(group, name, value))


@pytest.mark.parametrize('across', ['flat', 'sets'])
def test_tool_names_cannot_repeat_across_the_flat_list_and_toolsets(across):
    root = LlmAgent(name='root', model=llm('answer'), tools=[
        face.toolset([tool()]), tool() if across == 'flat' else face.toolset([tool()]),
    ])
    unsupported(lambda: Executor(root))


def interaction(requests):
    return {'surfaceId': 'main', 'viewRevision': 'r1', 'component': 'app.Approval/v1', 'props': {'requests': requests}}


@pytest.mark.parametrize('position', ['first', 'middle', 'last', 'nested', 'parallel', 'loop', 'two-parallel', 'long-parallel'])
def test_pause_scans_see_grouped_tools_exactly_as_flat_tools(position):
    outcomes = []
    for grouped in (False, True):
        confirming = tool(require_confirmation=position != 'long-parallel', long_running=position == 'long-parallel')
        leaf = LlmAgent(name='pause', model=llm('answer'), tools=[face.toolset([confirming]) if grouped else confirming])
        plain = lambda name: LlmAgent(name=name, model=llm('answer'))
        if position == 'first':
            root = SequentialAgent(name='root', sub_agents=[leaf, plain('tail')])
        elif position == 'middle':
            root = SequentialAgent(name='root', sub_agents=[plain('head'), leaf, plain('tail')])
        elif position == 'last':
            root = SequentialAgent(name='root', sub_agents=[plain('head'), leaf])
        elif position == 'nested':
            root = SequentialAgent(name='root', sub_agents=[SequentialAgent(name='inner', sub_agents=[leaf]), plain('tail')])
        elif position == 'loop':
            root = LoopAgent(name='root', max_iterations=2, sub_agents=[leaf])
        elif position == 'two-parallel':
            other = tool('other', require_confirmation=True)
            root = ParallelAgent(name='root', sub_agents=[leaf, LlmAgent(name='other', model=llm('answer'), tools=[other])])
        else:
            root = ParallelAgent(name='root', sub_agents=[leaf, plain('other')])
        try:
            executor = Executor(root, interaction=interaction)
            outcomes.append((executor._pausing, executor._resumable))
        except GalaxieError as error:
            outcomes.append(error.code)
    assert outcomes[0] == outcomes[1]
    assert (outcomes[0] == 'unsupported') == (position in ('loop', 'two-parallel', 'long-parallel'))


def execute(grouped):
    seen = []
    replies = iter([
        {'content': '', 'toolCalls': [{'id': 'call', 'type': 'function', 'function': {
            'name': 'double', 'arguments': '{"value":21}'}}]},
        {'value': 42}, {'content': 'done'},
    ])

    async def transport(raw):
        message = json.loads(raw)
        seen.append((message['op'], message['payload']))
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': next(replies)})

    _bridge.install_transport(transport)
    first, gated, other, last = tool('first'), tool(require_confirmation=True), tool('other'), tool('last')
    tools = [first, face.toolset([gated, other]), last] if grouped else [first, gated, other, last]
    executor = Executor(LlmAgent(name='root', model=llm('answer'), tools=cast(Any, tools)), interaction=interaction)
    assert asyncio.run(executor.run({'prompt': 'question'}, 's', 5)) is None
    pending = executor.pending('s')
    assert pending is not None
    assert asyncio.run(executor.run(None, 's', 5, resume={
        'interactionId': pending['id'], 'action': 'approve', 'payload': {'indexes': [0]},
    })) == 'done'
    assert [op for op, _ in seen] == ['model', 'capability', 'model']
    assert [entry['function']['name'] for entry in seen[0][1]['options']['tools']] == ['first', 'double', 'other', 'last']
    assert seen[1][1]['effectScope'] == 'adk-python/s/root/0/0'
    return seen, pending


def test_grouping_preserves_ordered_declarations_confirmation_and_one_effect():
    assert execute(True) == execute(False)
