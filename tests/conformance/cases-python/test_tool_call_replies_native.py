# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

# Gate | Observed | Result
# N1 | prebuilt/manual loops, ordered IDs, injected config, default rethrow | pass
# N2 | split argument chunks merge to the nonstreaming tool call | pass
# Scope | parallel calls share tools:<task>; model/tools differ; thread repeats
import asyncio
from typing import Any

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, RemoveMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import StructuredTool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.graph.message import REMOVE_ALL_MESSAGES
from langgraph.prebuilt import ToolNode


class NativeFailure(Exception):
    pass


class ToolReplyModel(BaseChatModel):
    calls: list[dict[str, Any]]

    @property
    def _llm_type(self) -> str:
        return 'native-tool-reply-fixture'

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        reply = (AIMessage(content='done', id='final') if messages[-1].type == 'tool'
                 else AIMessage(content='', id='calls', tool_calls=self.calls))
        return ChatResult(generations=[ChatGeneration(message=reply)])

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        return self._generate(messages, stop, run_manager, **kwargs)

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[{
            'index': 0, 'id': 'call-1', 'name': 'read', 'args': '{"value":',
        }]))
        yield ChatGenerationChunk(message=AIMessageChunk(content='', tool_call_chunks=[{
            'index': 0, 'id': None, 'name': None, 'args': '2}',
        }]))


def projection(messages):
    return [{
        'type': message.type, 'content': message.content, 'id': message.id,
        **({'tool_calls': message.tool_calls} if isinstance(message, AIMessage) else {}),
        **({'tool_call_id': message.tool_call_id} if isinstance(message, ToolMessage) else {}),
    } for message in messages]


def loop(model, tools, *, manual=False, handler=None, observations=None):
    async def chat(state, config: RunnableConfig):
        if observations is not None:
            observations.append(('model', config))
        return {'messages': [await model.ainvoke(state['messages'], config)]}

    async def invoke_tools(state, config: RunnableConfig):
        by_name = {tool.name: tool for tool in tools}
        replies = [await by_name[call['name']].ainvoke(call, config)
                   for call in state['messages'][-1].tool_calls]
        return {'messages': replies}

    node = (invoke_tools if manual else ToolNode(tools, **(
        {} if handler is None else {'handle_tool_errors': handler}
    )))
    return (StateGraph(MessagesState).add_node('model', chat).add_node('tools', node)
            .add_edge(START, 'model').add_conditional_edges('model', lambda state:
                'tools' if state['messages'][-1].tool_calls else END)
            .add_edge('tools', 'model').compile(checkpointer=InMemorySaver()))


async def native_record(*, manual=False, parallel=False):
    broker = []
    configs = []

    async def read(value: int, config: RunnableConfig):
        configs.append(('tool', config))
        broker.append(['read@1', {'value': value}])
        return '4'

    async def write(value: int, config: RunnableConfig):
        configs.append(('tool', config))
        broker.append(['write@1', {'value': value}])
        return 'saved'

    calls = [{'name': 'read', 'args': {'value': 2}, 'id': 'call-1', 'type': 'tool_call'}]
    if parallel:
        calls.append({'name': 'write', 'args': {'value': 4}, 'id': 'call-2', 'type': 'tool_call'})
    tools = [StructuredTool.from_function(coroutine=read, name='read', description='Read a value.'),
             StructuredTool.from_function(coroutine=write, name='write', description='Save a value.')]
    graph = loop(ToolReplyModel(calls=calls).bind_tools(tools), tools,
                 manual=manual, observations=configs)
    state = await graph.ainvoke({'messages': [HumanMessage('request', id='human')]},
                               {'configurable': {'thread_id': 'native'}})
    return {'final': state['messages'][-1].content, 'calls': broker,
            'writes': sum(name == 'write@1' for name, _ in broker),
            'messages': projection(state['messages'])}, configs


@pytest.mark.parametrize('manual', [False, True])
@pytest.mark.parametrize('parallel', [False, True])
def test_native_tool_loop_preserves_order_call_ids_and_injected_config(manual, parallel):
    record, configs = asyncio.run(native_record(manual=manual, parallel=parallel))
    assert record['final'] == 'done'
    assert [message['type'] for message in record['messages']] == (
        ['human', 'ai', 'tool', 'tool', 'ai'] if parallel else ['human', 'ai', 'tool', 'ai'])
    replies = [message for message in record['messages'] if message['type'] == 'tool']
    assert [message['tool_call_id'] for message in replies] == (['call-1', 'call-2'] if parallel else ['call-1'])
    assert [message['content'] for message in replies] == (['4', 'saved'] if parallel else ['4'])
    tool_configs = [config for kind, config in configs if kind == 'tool']
    assert all(config['configurable']['thread_id'] == 'native' for config in tool_configs)
    scopes = [config['metadata']['langgraph_checkpoint_ns'] for config in tool_configs]
    assert all(scope.startswith('tools:') for scope in scopes)
    if parallel:
        assert scopes[0] == scopes[1]  # In-node gather, not distinct Send tasks.


def test_node_namespaces_change_at_every_node_but_thread_id_repeats_between_runs():
    async def exercise():
        seen = []

        async def inspect_config(config: RunnableConfig):
            seen.append(('tool', config))
            return 'observed'

        tool = StructuredTool.from_function(coroutine=inspect_config, name='inspect', description='Inspect config.')
        model = ToolReplyModel(calls=[{'name': 'inspect', 'args': {}, 'id': 'inspect-1'}])
        graph = loop(model, [tool], observations=seen)
        for _ in range(2):
            await graph.ainvoke({'messages': [RemoveMessage(id=REMOVE_ALL_MESSAGES), HumanMessage('request')]},
                               {'configurable': {'thread_id': 'same-session'}, 'recursion_limit': 12})
        assert len(seen) == 6
        scopes = [config['metadata']['langgraph_checkpoint_ns'] for _, config in seen]
        assert len(set(scopes)) == 6
        assert all(config['configurable']['thread_id'] == 'same-session' for _, config in seen)
        assert [config['configurable']['checkpoint_ns'] for _, config in seen] == scopes
        # Dropping the task component leaves the same empty root in both runs.
        assert all('|' not in scope for scope in scopes)
        assert all('run_id' not in config for _, config in seen)
        assert all('run_id' not in config['metadata'] for _, config in seen)
        assert all('run_id' not in config['configurable'] for _, config in seen)
    asyncio.run(exercise())


@pytest.mark.parametrize('handler', [None, True, lambda error: 'handled'])
def test_default_toolnode_reraises_ordinary_failures_and_explicit_handlers_swallow_them(handler):
    async def fail():
        raise NativeFailure('fixed native failure')

    async def exercise():
        tool = StructuredTool.from_function(coroutine=fail, name='fail', description='Fail.')
        graph = loop(ToolReplyModel(calls=[{'name': 'fail', 'args': {}, 'id': 'failure'}]), [tool], handler=handler)
        value = {'messages': [HumanMessage('request')]}
        config: RunnableConfig = {'configurable': {'thread_id': 'errors'}}
        if handler is None:
            with pytest.raises(NativeFailure) as error:
                await graph.ainvoke(value, config)
            assert error.value.args == ('fixed native failure',)
        else:
            result = await graph.ainvoke(value, config)
            assert result['messages'][-2].status == 'error'
            assert result['messages'][-1].content == 'done'
    asyncio.run(exercise())


def test_native_streamed_tool_chunks_merge_to_nonstreaming_tool_call():
    async def exercise():
        model = ToolReplyModel(calls=[{'name': 'read', 'args': {'value': 2}, 'id': 'call-1'}])
        chunks = [chunk async for chunk in model.astream([HumanMessage('request')])]
        assert chunks[0].tool_call_chunks == [{
            'index': 0, 'id': 'call-1', 'name': 'read', 'args': '{"value":', 'type': 'tool_call_chunk',
        }]
        assert chunks[1].tool_call_chunks[0]['args'] == '2}'
        combined = chunks[0]
        for chunk in chunks[1:]:
            combined += chunk
        assert combined.tool_calls == (await model.ainvoke([HumanMessage('request')])).tool_calls
    asyncio.run(exercise())
