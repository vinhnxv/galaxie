# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Scoped candidate graph loaded by the unchanged real Pyodide driver."""

import asyncio
from typing import Any, cast

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode
from langgraph.config import get_stream_writer

from galaxie import GalaxieError
from galaxie.langgraph import checkpointer, request_interaction
from tool_scope import ScopedGraph, check, current
from tool_scoped_candidate import ScopedToolCandidate, scoped_capability_tool


REQUEST = {'surfaceId': 'main', 'viewRevision': 'r1',
           'component': 'conformance.Question/v1', 'props': {'question': 'Continue?'}}


def projection(messages):
    return [{
        'type': message.type, 'content': message.content, 'id': message.id,
        **({'tool_calls': message.tool_calls} if isinstance(message, AIMessage) else {}),
        **({'tool_call_id': message.tool_call_id} if isinstance(message, ToolMessage) else {}),
    } for message in messages]


def create_agent():
    schema = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}
    observed = []
    tools = []
    for name in ('read', 'write'):
        helper = scoped_capability_tool(name, f'{name}@1', schema, f'{name.title()} a value.')
        original = helper.coroutine
        assert original is not None

        def instrument(coroutine, kind):
            async def invoke(config: RunnableConfig, **arguments):
                observed.append([kind, check().id])
                try:
                    return await coroutine(config=config, **arguments)
                except GalaxieError:
                    scope = current.get()
                    if scope is not None and scope.failure is not None:
                        get_stream_writer()({'latched': scope.failure, 'fields': list(type(scope).__slots__)})
                    raise
            return invoke

        tools.append(helper.model_copy(update={'coroutine': instrument(original, name)}))

    async def child(state):
        observed.append(['subgraph', check().id])

        async def gather_child():
            observed.append(['gather', check().id])

        await asyncio.gather(gather_child(), gather_child())
        return state

    child_graph = (StateGraph(cast(Any, dict)).add_node('observe', child)
                   .add_edge(START, 'observe').add_edge('observe', END).compile())

    def model(state):
        return ScopedToolCandidate(role='answer', disable_streaming=True).bind_tools(
            tools, tool_choice=state.get('choice'))

    async def choose(state, config):
        observed.clear()
        observed.append(['model', check().id])
        history = [HumanMessage(state.get('scenario', 'read'), id='human')]
        reply = await model(state).ainvoke(history, config)
        reply.id = 'calls'
        return {**state, 'messages': [*history, reply]}

    async def work(state, config):
        handler = state.get('handler', 'default')
        options: dict[str, Any] = {} if handler == 'default' else {
            'handle_tool_errors': (lambda error: 'handled') if handler == 'callable' else True,
        }
        node = ToolNode(tools, **options)
        result = await node.ainvoke({'messages': state['messages']}, config)
        for message in result['messages']:
            message.id = f'tool-{message.tool_call_id}'
        if state.get('again'):
            await tools[1 if state['again'] == 'write' else 0].ainvoke({'value': 2}, config)
        if state.get('replay'):
            request_interaction(REQUEST, config)
        return {**state, 'messages': [*state['messages'], *result['messages']]}

    async def pause(state, config):
        if state.get('durable') and not state.get('replay'):
            request_interaction(REQUEST, config)
        return state

    async def finish(state, config):
        if state.get('silent'):
            return {'final': 'swallowed'}
        observed.append(['next-model', check().id])
        reply = await model(state).ainvoke(state['messages'], config)
        reply.id = 'final'
        return {'final': reply.content, 'messages': projection([*state['messages'], reply]),
                'scope_ids': observed, 'scope_fields': list(type(check()).__slots__)}

    graph = (StateGraph(cast(Any, dict)).add_node('choose', choose).add_node('child', child_graph)
             .add_node('work', work).add_node('pause', pause).add_node('finish', finish)
             .add_edge(START, 'choose').add_edge('choose', 'child').add_edge('child', 'work')
             .add_conditional_edges('work', lambda state: 'choose' if state.get('endless') else 'pause')
             .add_edge('pause', 'finish').add_edge('finish', END).compile(checkpointer=checkpointer()))
    return ScopedGraph(graph)
