# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Tree replacement preserves scripted results and writes, but not Workflow requests."""

import asyncio
import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest
from google.adk.agents import LlmAgent, ParallelAgent, SequentialAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.adk.tools.base_tool import BaseTool
from google.adk.workflow import JoinNode, Workflow
from google.genai import types

from galaxie import GalaxieError, _bridge
from galaxie.adk import Executor, capability_tool, llm


PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}
PROMPT = 'run the stages'


def oracle():
    path = Path(__file__).resolve().parents[3] / 'tests/conformance/cases-adk-python/native.py'
    spec = importlib.util.spec_from_file_location('workflow_replacement_mapping', path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def normalize(requests):
    """Use the standing per-agent ID convention, preserving all text and history."""
    module = oracle()
    module.renumber_per_agent(requests)
    return sorted(requests, key=lambda request: (request['agent'], json.dumps(request, sort_keys=True)))


async def observe(*, parallel, retry, native):
    requests = []
    invoked = []
    receipts = {}
    failed = False
    outputs = []
    errors = []
    writers = {'b': 1, 'c': 2} if parallel else {'a': 1, 'b': 2}
    mapping = oracle()

    def result(name, messages) -> dict[str, Any]:
        nonlocal failed
        after_tool = messages[-1]['role'] == 'tool'
        if name == 'b' and after_tool and retry and not failed:
            failed = True
            raise GalaxieError('unavailable')
        if name in writers and not after_tool:
            return {'content': '', 'toolCalls': [{'id': 'provider', 'type': 'function', 'function': {
                'name': 'write', 'arguments': json.dumps({'value': writers[name]}),
            }}]}
        return {'content': f'{name} done'}

    class Scripted(BaseLlm):
        async def generate_content_async(self, llm_request, stream=False):
            request = {'agent': self.model, **mapping.map_request(llm_request)}
            requests.append(request)
            reply = result(self.model, request['messages'])
            parts = ([types.Part(text=reply['content'])] if reply['content'] else []) + [
                types.Part(function_call=types.FunctionCall(
                    name=call['function']['name'], args=json.loads(call['function']['arguments']),
                )) for call in reply.get('toolCalls', [])
            ]
            yield LlmResponse(content=types.Content(role='model', parts=parts), turn_complete=True)

    class Write(BaseTool):
        def __init__(self):
            super().__init__(name='write', description='Store one integer.')

        def _get_declaration(self):
            return types.FunctionDeclaration(name='write', description=self.description, parameters_json_schema=PARAMETERS)

        async def run_async(self, *, args, tool_context):
            value = args['value']
            if value not in receipts:
                invoked.append(value)
                receipts[value] = {'value': value}
            return receipts[value]

    def leaf(name):
        tools = [Write() if native else capability_tool('write', 'notes.write@1', PARAMETERS, 'Store one integer.')] if name in writers else []
        return LlmAgent(name=name, model=Scripted(model=name) if native else llm(name),
                        instruction=f'Answer as {name}.', tools=tools)

    if native:
        root = Workflow(name='flow', edges=[('START', leaf('a'), (leaf('b'), leaf('c')),
                                          JoinNode(name='join'), leaf('merger'))]) if parallel else Workflow(
            name='flow', edges=[('START', leaf('a'), leaf('b'))])
        runner = InMemoryRunner(node=root, app_name='workflow_replacement')
        await runner.session_service.create_session(app_name='workflow_replacement', user_id='user', session_id='s')
        try:
            for _ in range(2 if retry else 1):
                try:
                    events = [event async for event in runner.run_async(user_id='user', session_id='s',
                              new_message=types.Content(role='user', parts=[types.Part(text=PROMPT)]))]
                except GalaxieError as error:
                    errors.append(error.code)
                    continue
                error = next((event for event in events if event.error_code), None)
                if error is not None:
                    errors.append('unavailable')
                else:
                    text = next((''.join(part.text or '' for part in event.content.parts or [])
                                 for event in reversed(events) if event.content and event.is_final_response()), '')
                    outputs.append(text)
        finally:
            await runner.close()
    else:
        root = SequentialAgent(name='pipeline', sub_agents=[leaf('a'),
            ParallelAgent(name='fanout', sub_agents=[leaf('b'), leaf('c')]), leaf('merger')]) if parallel else SequentialAgent(
                name='pipeline', sub_agents=[leaf('a'), leaf('b')])

        async def transport(raw):
            message = json.loads(raw)
            payload = message['payload']
            try:
                if message['op'] == 'capability':
                    scope = payload['effectScope']
                    if scope not in receipts:
                        invoked.append(payload['input']['value'])
                        receipts[scope] = payload['input']
                    reply = receipts[scope]
                else:
                    requests.append({'agent': payload['role'], 'messages': payload['messages'],
                                     'tools': payload['options'].get('tools', [])})
                    reply = result(payload['role'], payload['messages'])
                return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})
            except GalaxieError as error:
                return json.dumps({'v': message['v'], 'kind': 'response', 'id': message['id'], 'op': message['op'],
                                   'ok': False, 'error': {'code': error.code}})

        _bridge.install_transport(transport)
        executor = Executor(root)
        for _ in range(2 if retry else 1):
            try:
                outputs.append(await executor.run({'prompt': PROMPT}, 's', 20))
            except GalaxieError as error:
                errors.append(error.code)
    return {'requests': normalize(requests), 'invoked': sorted(invoked), 'outputs': outputs, 'errors': errors}


@pytest.mark.parametrize('parallel', [False, True])
@pytest.mark.parametrize('retry', [False, True])
def test_replacement_observation(parallel, retry):
    native = asyncio.run(observe(parallel=parallel, retry=retry, native=True))
    hosted = asyncio.run(observe(parallel=parallel, retry=retry, native=False))
    assert native['invoked'] == hosted['invoked'] == [1, 2]
    assert native['outputs'] == hosted['outputs'] == ['merger done' if parallel else 'b done']
    assert native['errors'] == hosted['errors'] == (['unavailable'] if retry else [])
    assert native['requests'] != hosted['requests']
    native_b = min((request for request in native['requests'] if request['agent'] == 'b'),
                   key=lambda request: len(request['messages']))
    hosted_b = min((request for request in hosted['requests'] if request['agent'] == 'b'),
                   key=lambda request: len(request['messages']))
    assert native_b['messages'] == [
        {'role': 'system', 'content': 'Answer as b.'}, {'role': 'user', 'content': 'a done'},
    ]
    assert hosted_b['messages'][0] == {
        'role': 'system', 'content': 'Answer as b.\n\nYou are an agent. Your internal name is "b".',
    }
    assert hosted_b['messages'][1] == {'role': 'user', 'content': PROMPT}
    assert len(hosted_b['messages']) == (3 if parallel else 5)
    assert all(message['role'] == 'user' for message in hosted_b['messages'][2:])
    assert hosted_b['messages'][-1]['content'].endswith('a done\n<<<END_QUOTED_AGENT_CONTENT>>>')
    assert native_b['tools'] == hosted_b['tools']


if __name__ == '__main__':
    results = {f'{parallel}-{retry}': asyncio.run(observe(parallel=parallel, retry=retry, native=True))
               for parallel in (False, True) for retry in (False, True)}
    print(json.dumps(results))
