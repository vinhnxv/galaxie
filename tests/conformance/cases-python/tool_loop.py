# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Executable text-protocol replacement; no native tool parts are accepted."""

import json
from typing import Any, cast

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph import END, START, StateGraph

from galaxie import GalaxieError, capabilities
from galaxie.langchain import GalaxieChatModel
from galaxie.langgraph import checkpointer, request_interaction

REQUEST = {'surfaceId': 'main', 'viewRevision': 'r1',
           'component': 'conformance.Question/v1', 'props': {'question': 'Continue?'}}


def create_agent():
    model = GalaxieChatModel(role='answer')

    async def choose(state, config):
        messages = [HumanMessage(state['scenario'])]
        if state.get('stream'):
            text = ''.join([chunk.text async for chunk in model.astream(messages, config)])
        else:
            text = str((await model.ainvoke(messages, config)).text)
        try:
            value = json.loads(text)
            if not isinstance(value, dict) or set(value) != {'calls'} or not isinstance(value['calls'], list):
                raise ValueError()
            for call in value['calls']:
                if (not isinstance(call, dict) or set(call) != {'name', 'input'}
                    or call['name'] not in ('read@1', 'write@1')
                    or not isinstance(call['input'], dict) or set(call['input']) != {'value'}
                    or type(call['input']['value']) is not int):
                    raise ValueError()
        except (TypeError, ValueError):
            raise GalaxieError('invalid') from None
        return {**state, 'request': text, 'calls': value['calls']}

    async def work(state, config):
        results = []
        for call in state['calls']:
            # Await directly; terminal broker failures must escape the node.
            results.append(await capabilities.call(call['name'], call['input'], config))
        if state.get('replay'):
            request_interaction(REQUEST, config)
        return {**state, 'results': results}

    async def pause(state, config):
        if state.get('durable') and not state.get('replay'):
            request_interaction(REQUEST, config)
        return state

    async def finish(state, config):
        result = await model.ainvoke([
            HumanMessage(state['scenario']), AIMessage(state['request']),
            HumanMessage(json.dumps(state['results'], separators=(',', ':'))),
        ], config)
        return {'final': result.content, 'calls': [[call['name'], call['input']] for call in state['calls']]}

    return (StateGraph(cast(Any, dict)).add_node('choose', choose).add_node('work', work)
            .add_node('pause', pause).add_node('finish', finish)
            .add_edge(START, 'choose').add_edge('choose', 'work').add_edge('work', 'pause')
            .add_edge('pause', 'finish').add_edge('finish', END).compile(checkpointer=checkpointer()))
