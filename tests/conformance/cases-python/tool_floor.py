# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Unshipped candidate under the real Worker: error handlers lose terminal codes."""

from typing import Any, cast

from langchain_core.messages import HumanMessage
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode

from galaxie.langgraph import checkpointer
from tool_candidate import ToolCandidate, capability_tool


def create_agent():
    schema = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}
    helper = capability_tool('read', 'read@1', schema, 'Read a value.')
    model = ToolCandidate(role='answer', disable_streaming=True).bind_tools([helper])

    async def choose(state, config):
        history = [HumanMessage('candidate')]
        reply = await model.ainvoke(history, config)
        return {**state, 'messages': [*history, reply]}

    async def work(state, config):
        handler = (lambda error: 'handled') if state.get('handler') == 'callable' else True
        result = await ToolNode([helper], handle_tool_errors=handler).ainvoke(state, config)
        if state.get('again'):
            await helper.ainvoke({'value': 2}, config)
        return {**state, 'messages': [*state['messages'], *result['messages']]}

    async def finish(state, config):
        reply = await model.ainvoke(state['messages'], config)
        return {'final': reply.content}

    return (StateGraph(cast(Any, dict)).add_node('choose', choose).add_node('work', work).add_node('finish', finish)
            .add_edge(START, 'choose').add_edge('choose', 'work').add_edge('work', 'finish')
            .add_edge('finish', END).compile(checkpointer=checkpointer()))
