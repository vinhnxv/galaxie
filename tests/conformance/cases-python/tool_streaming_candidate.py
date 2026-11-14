# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Unshipped streaming measurement; does not repair the helper's failed floor."""

import asyncio
from typing import Any, cast

from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGenerationChunk
from langgraph.graph import END, START, StateGraph

from galaxie import GalaxieError
from galaxie._bridge import request
from galaxie.langgraph import checkpointer
from tool_candidate import ToolCandidate, capability_tool

SCHEMA = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}


class StreamingToolCandidate(ToolCandidate):
    # The protected parent refusal generator infers Never; this test-only subclass yields chunks.
    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):  # pyright: ignore[reportIncompatibleMethodOverride]
        payload = self._payload(messages, stop)
        payload['options']['stream'] = True
        queue = asyncio.Queue()
        task = asyncio.create_task(request('model', payload, on_model_chunk=queue.put_nowait))
        task.add_done_callback(lambda _: queue.put_nowait(None))
        combined = AIMessageChunk(content='')
        try:
            while (delta := await queue.get()) is not None:
                chunk = AIMessageChunk(content=delta['content'], tool_call_chunks=[{
                    'index': call['index'], 'id': call.get('id'),
                    'name': call['function'].get('name'), 'args': call['function'].get('arguments'),
                } for call in delta.get('toolCalls', [])])
                combined += chunk
                yield ChatGenerationChunk(message=chunk)
            reply = self.decode(await task)
            if combined.content != reply.content or combined.tool_calls != reply.tool_calls or combined.invalid_tool_calls:
                raise GalaxieError('invalid')
            yield ChatGenerationChunk(message=AIMessageChunk(content='', usage_metadata=reply.usage_metadata,
                                                             chunk_position='last'))
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def bound():
    return StreamingToolCandidate(role='answer').bind_tools([
        capability_tool('read', 'read@1', SCHEMA, 'Read a value.'),
        capability_tool('other', 'read@1', SCHEMA, 'Read another value.'),
    ])


def serialization(form):
    model = bound()
    call = AIMessage(content='', tool_calls=[{'name': 'read', 'args': {'value': 2}, 'id': 'call-1'}])
    messages = {
        'string': ToolMessage('4', tool_call_id='call-1'),
        'list': ToolMessage(['4'], tool_call_id='call-1'),
        'error': ToolMessage('4', tool_call_id='call-1', status='error'),
        'artifact': ToolMessage('4', tool_call_id='call-1', artifact={'value': 4}),
        'unknown': ToolMessage('4', tool_call_id='unknown'),
    }
    return model._payload([call, messages[form]], None)['messages'][-1]


def create_agent():
    async def node(state, config):
        if 'serialization' in state:
            return serialization(state['serialization'])
        combined = AIMessageChunk(content='')
        async for chunk in bound().astream([HumanMessage(state['scenario'])], config):
            combined += chunk
        results = []
        for call in combined.tool_calls:
            helper = capability_tool(call['name'], 'read@1', SCHEMA, 'Read a value.')
            results.append(await helper.ainvoke(call['args'], config))
        return {'calls': combined.tool_calls, 'results': results}
    return (StateGraph(cast(Any, dict)).add_node('node', node).add_edge(START, 'node')
            .add_edge('node', END).compile(checkpointer=checkpointer()))
