# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Native tool-loop reference with explicit graph message identities."""

from typing import Any, cast

from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import StructuredTool
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode

from test_tool_call_replies_native import ToolReplyModel, projection


async def record(parallel=False, write_only=False, mixed=False):
    broker = []

    async def read(value: int, config: RunnableConfig):
        broker.append(['read@1', {'value': value}])
        return '4'

    async def write(value: int, config: RunnableConfig):
        broker.append(['write@1', {'value': value}])
        return 'saved'

    tools = [StructuredTool.from_function(coroutine=read, name='read', description='Read a value.'),
             StructuredTool.from_function(coroutine=write, name='write', description='Write a value.')]
    calls = [{'id': 'call-1', 'name': 'write' if write_only else 'read',
              'args': {'value': 4 if write_only else 2}}]
    if parallel:
        calls.append({'id': 'call-2', 'name': 'write' if mixed else 'read', 'args': {'value': 4}})
    model = ToolReplyModel(calls=calls)

    async def choose(state, config: RunnableConfig):
        scenario = 'parallel-write' if mixed else 'parallel' if parallel else 'write' if write_only else 'read'
        history = [HumanMessage(scenario, id='human')]
        reply = await model.ainvoke(history, config)
        reply.id = 'calls'
        return {'messages': [*history, reply]}

    async def work(state, config: RunnableConfig):
        result = await ToolNode(tools).ainvoke(state, config)
        for message in result['messages']:
            message.id = f'tool-{message.tool_call_id}'
        return {'messages': [*state['messages'], *result['messages']]}

    async def finish(state, config: RunnableConfig):
        reply = await model.ainvoke(state['messages'], config)
        reply.id = 'final'
        return {'final': reply.content, 'messages': projection([*state['messages'], reply])}

    graph = (StateGraph(cast(Any, dict)).add_node('choose', choose).add_node('work', work)
             .add_node('finish', finish).add_edge(START, 'choose').add_edge('choose', 'work')
             .add_edge('work', 'finish').add_edge('finish', END).compile())
    result = await graph.ainvoke({})
    return {**result, 'calls': broker, 'writes': sum(name == 'write@1' for name, _ in broker),
            'models': 2, 'tools': len(calls)}
