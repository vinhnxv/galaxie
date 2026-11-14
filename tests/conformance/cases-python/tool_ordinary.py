# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Measurement of ordinary author tools over checked text requests."""

import json
from typing import Any, cast

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import StructuredTool
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode
from pydantic import BaseModel

from galaxie import capabilities
from galaxie.langchain import GalaxieChatModel
from galaxie.langgraph import checkpointer

SCHEMA = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}


class Arguments(BaseModel):
    value: int


def ordinary_tool(name='read', capability='read@1', *, pydantic=False, flagged: Any=True):
    async def invoke(config: RunnableConfig, **arguments):
        return await capabilities.call(capability, arguments, config, tool=flagged)

    return StructuredTool(name=name, description='A counted author capability.',
                          args_schema=Arguments if pydantic else SCHEMA, coroutine=invoke)


def create_agent():
    model = GalaxieChatModel(role='answer')

    async def choose(state, config):
        reply = await model.ainvoke([HumanMessage(state['scenario'])], config)
        return {**state, 'calls': json.loads(str(reply.content))['calls']}

    async def work(state, config):
        tools = [ordinary_tool('read', state.get('capability', 'read@1'),
                               pydantic=state.get('pydantic', False), flagged=state.get('flagged', True)),
                 ordinary_tool('write', 'write@1', flagged=state.get('flagged', True))]
        kwargs = {}
        if state.get('handler') == 'true':
            kwargs['handle_tool_errors'] = True
        elif state.get('handler') == 'callable':
            kwargs['handle_tool_errors'] = lambda error: 'Handled tool error.'
        reply = await ToolNode(tools, **kwargs).ainvoke({'messages': [AIMessage(content='', tool_calls=[
            {'name': call['name'], 'args': call['input'], 'id': f'call-{index}', 'type': 'tool_call'}
            for index, call in enumerate(state['calls'])
        ])]}, config)
        return {**state, 'results': [message.content for message in reply['messages']],
                'statuses': [message.status for message in reply['messages']]}

    async def finish(state, config):
        reply = await model.ainvoke([HumanMessage('finish')], config)
        return {'final': reply.content, 'results': state['results'], 'statuses': state['statuses']}

    return (StateGraph(cast(Any, dict)).add_node('choose', choose).add_node('work', work)
            .add_node('finish', finish).add_edge(START, 'choose').add_edge('choose', 'work')
            .add_edge('work', 'finish').add_edge('finish', END).compile(checkpointer=checkpointer()))
