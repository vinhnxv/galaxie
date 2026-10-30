# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio

from galaxie.langchain import GalaxieChatModel
from langgraph.config import get_stream_writer
from langgraph.graph import StateGraph, START, END


def factory(checkpointer, **kwargs):
    async def respond(state, config):
        writer = get_stream_writer()
        kind = state.get('kind')
        if kind == 'non-json':
            writer({'private': b'UNSUPPORTED-PRIVATE'})
            return {}
        if kind == 'oversized':
            writer({'private': 'UNSUPPORTED-PRIVATE' * 60000})
            return {}
        if kind in ('close', 'close-block'):
            stream = GalaxieChatModel(role='answer').astream('stream request', config)
            chunk = await anext(stream)
            await stream.aclose()
            writer({'closed': True})
            if kind == 'close-block':
                await asyncio.sleep(0.2)
            return {'text': chunk.content, 'usage': None}
        content = ''
        usage = None
        async for chunk in GalaxieChatModel(role='answer').astream('stream request', config):
            writer({'seen': chunk.content})
            content += chunk.content
            if chunk.usage_metadata is not None:
                usage = chunk.usage_metadata
        return {'text': content, 'usage': usage}

    return (StateGraph(dict).add_node('respond', respond).add_edge(START, 'respond')
        .add_edge('respond', END).compile(checkpointer=checkpointer))
