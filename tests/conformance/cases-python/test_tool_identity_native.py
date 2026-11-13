# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native context-propagation premises, independent of the helper candidate."""

import asyncio
from contextvars import ContextVar
from types import SimpleNamespace

import pytest
from langchain_core.messages import HumanMessage
from langchain_core.tools import StructuredTool
from langgraph.graph import END, START, MessagesState, StateGraph

from test_tool_call_replies_native import ToolReplyModel, loop, projection


visible: ContextVar[SimpleNamespace | None] = ContextVar('identity_premise', default=None)


async def scoped_stream(graph, scope, value, config):
    token = visible.set(scope)
    stream = graph.astream(value, config, stream_mode='values')
    try:
        async for item in stream:
            yield item
    finally:
        await stream.aclose()
        visible.reset(token)


@pytest.mark.parametrize('parallel', [False, True])
def test_scope_reaches_model_and_tools_and_child_mutation_reaches_parent(parallel):
    async def exercise():
        seen = []

        class ObservingModel(ToolReplyModel):
            async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
                scope = visible.get()
                assert scope is not None
                seen.append(('model', scope, scope.failure))
                return await super()._agenerate(messages, stop, run_manager, **kwargs)

        async def inspect_scope():
            scope = visible.get()
            assert scope is not None
            seen.append(('tool', scope, scope.failure))
            scope.failure = 'observed'
            return 'observed'

        tool = StructuredTool.from_function(coroutine=inspect_scope, name='inspect', description='Observe identity.')
        calls = [{'name': 'inspect', 'args': {}, 'id': 'first'}]
        if parallel:
            calls.append({'name': 'inspect', 'args': {}, 'id': 'second'})
        graph = loop(ObservingModel(calls=calls), [tool])
        for identity in (1, 2):
            scope = SimpleNamespace(id=identity, failure=None)
            states = [item async for item in scoped_stream(graph, scope,
                {'messages': [HumanMessage('request')]},
                {'configurable': {'thread_id': f'run-{identity}'}})]
            assert projection(states[-1]['messages'])[-1]['content'] == 'done'
            assert visible.get() is None
            current = seen[-(4 if parallel else 3):]
            assert all(observed is scope for _, observed, _ in current)
            assert current[0][2] is None
            assert current[-1][2] == 'observed'
        assert seen[0][1].id != seen[-1][1].id

    asyncio.run(exercise())


def test_scope_reaches_subgraph_and_author_gather_children():
    async def exercise():
        seen = []

        async def child():
            seen.append(visible.get())

        async def node(state):
            seen.append(visible.get())
            await asyncio.gather(child(), child())
            return state

        child_graph = (StateGraph(MessagesState).add_node('inspect', node)
                       .add_edge(START, 'inspect').add_edge('inspect', END).compile())
        graph = (StateGraph(MessagesState).add_node('child', child_graph)
                 .add_edge(START, 'child').add_edge('child', END).compile())
        scope = SimpleNamespace(id=1, failure=None)
        async for _ in scoped_stream(graph, scope, {'messages': []}, {}):
            pass
        assert len(seen) == 3
        assert all(observed is scope for observed in seen)
        assert visible.get() is None

    asyncio.run(exercise())


def test_early_close_resets_scope_and_an_unscoped_tool_observes_none():
    async def exercise():
        async def inspect_scope():
            return visible.get()

        tool = StructuredTool.from_function(coroutine=inspect_scope, name='inspect', description='Observe scope.')
        graph = loop(ToolReplyModel(calls=[]), [tool])
        stream = scoped_stream(graph, SimpleNamespace(id=1, failure=None),
                               {'messages': [HumanMessage('request')]},
                               {'configurable': {'thread_id': 'close'}})
        await anext(stream)
        await stream.aclose()
        assert visible.get() is None
        assert await tool.ainvoke({}) is None

    asyncio.run(exercise())
