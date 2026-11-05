# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
from collections.abc import AsyncGenerator
from typing import Any, cast

from langchain_core.messages import AIMessageChunk

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
            # BaseChatModel.astream is typed as an iterator but returns an async generator.
            stream = cast(AsyncGenerator[AIMessageChunk, None], GalaxieChatModel(role='answer').astream('stream request', config))
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
            content += chunk.text
            if chunk.usage_metadata is not None:
                usage = chunk.usage_metadata
        return {'text': content, 'usage': usage}

    # A plain dict schema keeps LangGraph's single root-value channel, which the stub does not model.
    return (StateGraph(cast(Any, dict)).add_node('respond', respond).add_edge(START, 'respond')
        .add_edge('respond', END).compile(checkpointer=checkpointer))
