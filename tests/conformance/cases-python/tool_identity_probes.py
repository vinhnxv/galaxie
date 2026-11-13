# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Worker-loadable refusal and context-lifetime probes; no policy replacement."""

import asyncio
from typing import Any, cast

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel

from galaxie import GalaxieError
from galaxie.langchain import GalaxieChatModel
from galaxie.langgraph import checkpointer
from tool_scope import ScopedGraph, check, current
from tool_scoped_candidate import ScopedToolCandidate, scoped_capability_tool


SCHEMA = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}


class PlainSchema(BaseModel):
    value: int


@tool
def plain(value: int) -> str:
    """An ordinary author tool."""
    return str(value)


def helper():
    return scoped_capability_tool('read', 'read@1', SCHEMA, 'Read a value.')


def create_agent():
    async def probe(state, config):
        kind = state['probe']
        model = ScopedToolCandidate(role='answer', disable_streaming=True)
        if kind == 'lifetime':
            parent = check()
            ready, read = asyncio.Event(), asyncio.Event()

            async def mutate():
                parent.failure = 'invalid'
                ready.set()
                await read.wait()
                parent.failure = None

            async def observe():
                await ready.wait()
                scope = current.get()
                assert scope is not None and scope is parent and scope.failure == 'invalid'
                read.set()

            await asyncio.gather(mutate(), observe())

            class Graph:
                async def astream(self):
                    yield check().id
                    yield check().id

            stream = ScopedGraph(Graph()).astream()
            nested = await anext(stream)
            await stream.aclose()
            assert current.get() is parent
            token = current.set(None)
            try:
                assert current.get() is None
                try:
                    await helper().ainvoke({'value': 2})
                except GalaxieError as error:
                    assert error.code == 'unsupported'
                else:
                    raise AssertionError('Unscoped helper reached transport.')
            finally:
                current.reset(token)
            return {'mutation_visible': True, 'early_close_reset': True, 'unscoped_refused': True,
                    'parent_id': parent.id, 'nested_id': nested}
        if kind in ('plain', 'callable', 'dict', 'class'):
            bindings = {'plain': plain, 'callable': lambda: None,
                        'dict': {'type': 'function'}, 'class': PlainSchema}
            model.bind_tools([bindings[kind]])
        elif kind == 'hostile-latch':
            scope = check()
            marker = 'PRIVATE-MARKER-hostile-scope'
            try:
                await helper().ainvoke({'value': marker}, config)
            except GalaxieError as error:
                assert error.code == 'invalid'
            assert scope.failure == 'invalid'
            assert set(type(scope).__slots__) == {'id', 'failure'}
            assert marker not in repr(scope)
            for action in (helper().ainvoke({'value': marker}, config),
                           model.bind_tools([helper()]).ainvoke([HumanMessage(marker)], config)):
                try:
                    await action
                except GalaxieError as error:
                    assert error.code == 'invalid' and marker not in str(error)
                else:
                    raise AssertionError('Request after failure latch.')
            raise GalaxieError('invalid')
        elif kind == 'kwargs':
            model.bind_tools([], strict=True)
        elif kind == 'choice':
            model.bind_tools([], tool_choice='missing')
        elif kind == 'duplicate':
            model.bind_tools([helper(), helper()])
        elif kind == 'name':
            scoped_capability_tool('invalid-name', 'read@1', SCHEMA, 'Read.')
        elif kind == 'oversized-schema':
            scoped_capability_tool('read', 'read@1', {'type': 'object', 'description': 'x' * 1_048_576}, 'Read.')
        elif kind == 'function-output':
            model.with_structured_output(PlainSchema)
        elif kind == 'stream':
            streaming = ScopedToolCandidate(role='answer')
            async for _ in streaming.bind_tools([helper()]).astream([HumanMessage('PRIVATE-MARKER')], config):
                pass
        elif kind == 'text':
            return {'final': (await model.ainvoke([HumanMessage('plain-text')], config)).content}
        elif kind == 'unbound-history':
            await model.ainvoke([AIMessage('', tool_calls=[{
                'id': 'call-1', 'name': 'read', 'args': {'value': 2},
            }])], config)
        elif kind == 'text-stream':
            text = ''.join([chunk.text async for chunk in GalaxieChatModel(role='answer').astream(
                [HumanMessage('plain-text')], config)])
            return {'final': text}
        else:
            messages = {
                'human-block': HumanMessage([{'type': 'text', 'text': 'PRIVATE-MARKER'}]),
                'ai-block': AIMessage([{'type': 'text', 'text': 'PRIVATE-MARKER'}]),
                'tool-block': ToolMessage(['PRIVATE-MARKER'], tool_call_id='call-1'),
                'artifact': ToolMessage('PRIVATE-MARKER', tool_call_id='call-1', artifact={'private': True}),
                'error-status': ToolMessage('PRIVATE-MARKER', tool_call_id='call-1', status='error'),
                'orphan': ToolMessage('PRIVATE-MARKER', tool_call_id='orphan'),
            }
            await model.bind_tools([helper()]).ainvoke([messages[kind]], config)
        raise AssertionError('Refused shape unexpectedly ran.')

    return ScopedGraph(StateGraph(cast(Any, dict)).add_node('probe', probe)
                       .add_edge(START, 'probe').add_edge('probe', END).compile(checkpointer=checkpointer()))
