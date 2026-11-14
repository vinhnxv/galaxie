# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest
from google.adk.agents import LlmAgent
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.adk.tools.base_tool import BaseTool
from google.adk.workflow import JoinNode, Workflow
from google.genai import types

from galaxie import _bridge
from galaxie import adk

PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}


def mapping():
    path = Path(__file__).resolve().parents[3] / 'tests/conformance/cases-adk-python/native.py'
    spec = importlib.util.spec_from_file_location('workflow_candidate_mapping', path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def observe(*, native, fanout, reverse=False, restored=False):
    observed: dict[str, Any] = {'requests': [], 'writes': [], 'scopes': [], 'outputs': [], 'authors': []}
    mapper = mapping()

    async def reply(name, messages):
        if name in ('b', 'c') and fanout and messages[-1]['role'] != 'tool':
            if (name == 'b') == reverse:
                await asyncio.sleep(0.01)
            return {'content': '', 'toolCalls': [{'id': 'provider', 'type': 'function', 'function': {
                'name': 'write', 'arguments': json.dumps({'value': 1 if name == 'b' else 2}),
            }}]}
        return {'content': name + ' answer'}

    class Scripted(BaseLlm):
        async def generate_content_async(self, llm_request, stream=False):
            request = {'agent': self.model, **mapper.map_request(llm_request)}
            observed['requests'].append(request)
            result = await reply(self.model, request['messages'])
            parts = ([types.Part(text=result['content'])] if result['content'] else []) + [
                types.Part(function_call=types.FunctionCall(name=call['function']['name'],
                      args=json.loads(call['function']['arguments']))) for call in result.get('toolCalls', [])]
            if stream and result['content']:
                yield LlmResponse(content=types.Content(role='model', parts=[types.Part(text=result['content'])]), partial=True)
            yield LlmResponse(content=types.Content(role='model', parts=parts), turn_complete=True)

    class Write(BaseTool):
        def __init__(self):
            super().__init__(name='write', description='Store one integer.')

        def _get_declaration(self):
            return types.FunctionDeclaration(name='write', description=self.description, parameters_json_schema=PARAMETERS)

        async def run_async(self, *, args, tool_context):
            observed['writes'].append(args['value'])
            return args

    def build():
        def leaf(name):
            tools = [Write() if native else adk.capability_tool('write', 'notes.write@1', PARAMETERS,
                     'Store one integer.')] if fanout and name in ('b', 'c') else []
            return LlmAgent(name=name, model=Scripted(model=name) if native else adk.llm(name),
                            instruction=f'Answer as {name}.', output_key=f'{name}_result', tools=tools)
        edges = [('START', leaf('a'), (leaf('b'), leaf('c')), JoinNode(name='join'))] if fanout else [
            ('START', leaf('a'), leaf('b'))]
        return Workflow(name='wf', edges=edges) if native else adk.workflow(name='wf', edges=edges)

    if native:
        runner = InMemoryRunner(node=build(), app_name='workflow_candidate')
        await runner.session_service.create_session(app_name='workflow_candidate', user_id='user', session_id='s')
        try:
            for prompt in (('first', 'second') if restored else ('first',)):
                events = [event async for event in runner.run_async(user_id='user', session_id='s',
                          new_message=types.Content(role='user', parts=[types.Part(text=prompt)]),
                          run_config=RunConfig(streaming_mode=StreamingMode.SSE))]
                observed['authors'].extend(event.author for event in events if event.partial and event.content)
                final = [event for event in events if 'wf@1' in (event.node_info.output_for or [])][-1]
                observed['outputs'].append(final.output if final.output is not None else ''.join(
                    part.text or '' for part in final.content.parts or []))
        finally:
            await runner.close()
    else:
        async def transport(raw):
            message = json.loads(raw)
            payload = message['payload']
            if message['op'] == 'capability':
                observed['writes'].append(payload['input']['value'])
                observed['scopes'].append(payload['effectScope'])
                result = payload['input']
            else:
                observed['requests'].append({'agent': payload['role'], 'messages': [
                    {('tool_calls' if key == 'toolCalls' else key): value for key, value in item.items()}
                    for item in payload['messages']],
                                            'tools': payload['options'].get('tools', [])})
                result = await reply(payload['role'], payload['messages'])
            if message['op'] == 'model' and payload.get('options', {}).get('stream') and result['content']:
                _bridge.receive_model_chunk(json.dumps({**message, 'kind': 'notify', 'op': 'model-chunk',
                                           'payload': {'content': result['content']}}))
                await asyncio.sleep(0)
            return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': result})
        _bridge.install_transport(transport)
        executor = adk.Executor(build())
        def stream(mode, data):
            if mode == 'messages':
                observed['authors'].append(data['author'])
        observed['outputs'].append(await executor.run({'prompt': 'first'}, 's', 20, stream))
        if restored:
            checkpoint, metadata = executor._snapshot('s')
            executor = adk.Executor(build())
            await executor._restore(checkpoint, metadata)
            observed['outputs'].append(await executor.run({'prompt': 'second'}, 's', 20))
    mapper.renumber_per_agent(observed['requests'])
    observed['requests'].sort(key=lambda request: (request['agent'], json.dumps(request, sort_keys=True)))
    observed['writes'].sort()
    return observed


@pytest.mark.parametrize('fanout', [False, True])
@pytest.mark.parametrize('reverse', [False, True])
def test_registered_workflow_requests_and_result_equal_native(fanout, reverse):
    native = asyncio.run(observe(native=True, fanout=fanout, reverse=reverse))
    hosted = asyncio.run(observe(native=False, fanout=fanout, reverse=reverse))
    assert hosted['outputs'] == native['outputs']
    assert hosted['requests'] == native['requests']
    assert hosted['writes'] == native['writes']
    assert sorted(hosted['authors']) == sorted(native['authors']) == (['a', 'b', 'c'] if fanout else ['a', 'b'])


def test_completed_workflow_restores_and_next_turn_equals_native():
    native = asyncio.run(observe(native=True, fanout=False, restored=True))
    hosted = asyncio.run(observe(native=False, fanout=False, restored=True))
    assert hosted['outputs'] == native['outputs']
    assert hosted['requests'] == native['requests']


if __name__ == '__main__':
    print(json.dumps({str(fanout): asyncio.run(observe(native=True, fanout=fanout)) for fanout in (False, True)}))
