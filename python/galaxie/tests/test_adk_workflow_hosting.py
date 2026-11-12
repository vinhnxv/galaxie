# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Workflow hosting boundary and a limited static tree replacement.

Gate | Observed | Result
NW2 | Node Runner can share the session service and integrity plugin | PASS
GW1 | Static FunctionNode kind checks cannot establish model routing | not established
GW2-GW6 | Not measured: support outcome fixed by GW1 | unmeasured
AL-W | Chain/fan-out retry uses fake receipts; full route parity is unmeasured | not established
B-py | Workflow remains refused at prepare | REFUSED

The manifest probe is deliberately test-only: a static node-kind allow-list
cannot prove routing for author function nodes. This is a counterexample to
manifest-only admission, not a claim about all possible Workflow adapters.
No production validator is weakened and no external model is called.
"""

import asyncio
import json

import pytest
from google.adk.agents import LlmAgent, ParallelAgent, SequentialAgent
from google.adk.agents.context import Context
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.workflow import FunctionNode, Workflow
from google.genai import types

from galaxie import GalaxieError, _bridge
from galaxie import adk as face
from galaxie.adk import Executor, capability_tool, llm


def test_workflow_is_refused_before_any_bridge_dispatch():
    async def forbidden(raw):
        pytest.fail('prepare must not dispatch')

    _bridge.install_transport(forbidden)
    flow = Workflow(name='wf', edges=[('START', LlmAgent(name='a', model=llm('answer')))])
    with pytest.raises(GalaxieError) as error:
        Executor(flow)
    assert error.value.code == 'unsupported'


def test_static_function_node_manifest_does_not_close_model_dispatch():
    calls = []

    class Scripted(BaseLlm):
        async def generate_content_async(self, llm_request, stream=False):
            calls.append(self.model)
            yield LlmResponse(content=types.Content(role='model', parts=[types.Part(text='hidden')]))

    hidden = LlmAgent(name='hidden', model=Scripted(model='unregistered_script'))

    async def dispatch(ctx: Context):
        return [reply async for reply in hidden.model.generate_content_async(None)]

    declared = FunctionNode(name='declared', func=dispatch)
    flow = Workflow(name='wf', edges=[('START', declared)])
    # These are exactly the allowed static node kinds; the hidden node is not in the graph.
    assert type(declared) is FunctionNode
    assert [node.name for node in flow.graph.nodes if node.name != '__START__'] == ['declared']

    async def run():
        sessions = face.GalaxieSessionService()
        runner = Runner(node=flow, app_name=face.APP_NAME, session_service=sessions,
                        plugins=[face.ToolCallIntegrityPlugin(secret_key=b'x' * 32)])
        await sessions.create_session(app_name=face.APP_NAME, user_id=face.USER_ID, session_id='s1')
        return [event async for event in runner.run_async(
            user_id=face.USER_ID, session_id='s1', new_message=types.Content(role='user', parts=[types.Part(text='go')]),
        )]

    asyncio.run(run())
    assert calls == ['unregistered_script']


@pytest.mark.parametrize('parallel', [False, True])
def test_static_chain_and_fanout_replacement_replay_each_write_once(parallel):
    receipts = {}
    bodies = []
    fail = True

    async def transport(raw):
        nonlocal fail
        message = json.loads(raw)
        payload = message['payload']
        if message['op'] == 'capability':
            scope = payload['effectScope']
            if scope not in receipts:
                bodies.append(payload['input']['value'])
                receipts[scope] = {'value': payload['input']['value']}
            reply = receipts[scope]
        else:
            role = payload['role']
            if payload['messages'][-1]['role'] == 'tool':
                if role == 'b' and fail:
                    fail = False
                    return json.dumps({key: value for key, value in {
                        **message, 'kind': 'response', 'ok': False, 'error': {'code': 'unavailable'},
                    }.items() if key != 'payload'})
                reply = {'content': role}
            else:
                reply = {'content': '', 'toolCalls': [{'id': 'write', 'type': 'function', 'function': {
                    'name': 'write', 'arguments': json.dumps({'value': 1 if role == 'a' else 2}),
                }}]}
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})

    _bridge.install_transport(transport)
    tools = lambda: [capability_tool('write', 'notes.write@1', {
        'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value'],
    }, 'Write a value.')]
    cls = ParallelAgent if parallel else SequentialAgent
    root = cls(name='root', sub_agents=[LlmAgent(name=name, model=llm(name), tools=tools()) for name in ('a', 'b')])
    executor = Executor(root)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'go'}, 's1', 10))
    assert error.value.code == 'unavailable'
    asyncio.run(executor.run({'prompt': 'go'}, 's1', 10))
    assert sorted(bodies) == [1, 2]
    assert len(receipts) == 2
    assert all(scope.startswith('adk-python/s1/') for scope in receipts)
