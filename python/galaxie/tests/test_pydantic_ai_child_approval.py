# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
import re
from dataclasses import replace
from typing import Any

import pytest
from pydantic_ai import Agent, DeferredToolRequests, DeferredToolResults, RunContext
from pydantic_ai.messages import ModelRequest, UserPromptPart
from pydantic_ai.usage import RunUsage

from galaxie import GalaxieError, _bridge
from galaxie import pydantic_ai as face
from galaxie.pydantic_ai import Executor, GalaxieModel, capability_tool, run_child


RESERVED = 'galaxie.child-approval'
SCHEMA = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}


def call(name='delegate', identifier='delegate', arguments='{}'):
    return {'id': identifier, 'type': 'function', 'function': {'name': name, 'arguments': arguments}}


def display(requests):
    children = face.hoisted_child_requests(requests)

    def shown(part):
        return {'id': part.tool_call_id, 'name': part.tool_name, 'arguments': part.args_as_json_str()}

    return {
        'surfaceId': 'main', 'viewRevision': 'approval-1', 'component': 'tests.Approval/v1',
        'props': {'calls': [{**shown(part), 'child': [shown(child) for child in children[part.tool_call_id].approvals]
                            if part.tool_call_id in children else []} for part in requests.approvals]},
    }


def scenario(*, output_type=None, delegate=None, interaction=display, resume=None, child_tools=None):
    seen = []
    contexts = []
    write = capability_tool('save', 'records.save@1', SCHEMA)
    write.requires_approval = True
    child = Agent(GalaxieModel('child'), output_type=output_type or [str, DeferredToolRequests], tools=child_tools or [write])
    parent = Agent(GalaxieModel('parent'), output_type=[str, DeferredToolRequests])

    @child.output_validator
    def remember(ctx: RunContext, output: Any) -> Any:
        contexts.append(ctx)
        return output

    @parent.tool
    async def delegate_tool(ctx: RunContext) -> str:
        if delegate is not None:
            return await delegate(ctx, child)
        result = await run_child(ctx, child, 'child', hoist_approvals=True)
        assert not isinstance(result.output, DeferredToolRequests)
        return result.output

    # The public registration name is the one used in the model fixture.
    parent = Agent(GalaxieModel('parent'), output_type=[str, DeferredToolRequests], tools=[
        face.Tool(delegate_tool, name='delegate'),
    ])

    async def transport(raw):
        message = json.loads(raw)
        seen.append(message)
        payload = message['payload']
        if message['op'] == 'capability':
            reply = 'saved'
        elif payload['role'] == 'parent':
            reply = {'content': 'parent-done'} if payload['messages'][-1]['role'] == 'tool' else {
                'content': '', 'toolCalls': [call()],
            }
        else:
            reply = {'content': 'child-done'} if payload['messages'][-1]['role'] == 'tool' else {
                'content': '', 'toolCalls': [call('save', 'save', '{"value":2}')],
            }
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})

    _bridge.install_transport(transport)
    return Executor(parent, interaction=interaction, resume=resume), seen, contexts


def answer(executor, action='approve', *, conversation='fixed', identifiers=None):
    pending = executor.pending(conversation)
    assert pending is not None
    return {'interactionId': pending['id'], 'action': action, 'payload': {'toolCallIds': identifiers or ['delegate']}}


def writes(seen):
    return [message['payload'] for message in seen if message['op'] == 'capability']


@pytest.mark.parametrize('action', ['approve', 'deny'])
def test_child_gate_runs_only_after_approval_and_deny_abandons_it(action):
    executor, seen, _ = scenario()

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) is None
        pending = executor.pending('fixed')
        assert pending is not None
        assert pending['value']['props']['calls'][0]['child'] == [
            {'id': 'save', 'name': 'save', 'arguments': '{"value":2}'},
        ]
        assert writes(seen) == []
        submission = answer(executor, action)
        assert await executor.run(None, 'fixed', 8, resume=submission) == 'parent-done'
        assert executor.pending('fixed') is None
        with pytest.raises(GalaxieError) as stale:
            await executor.run(None, 'fixed', 8, resume=submission)
        assert stale.value.code == 'stale'

    asyncio.run(run())
    assert len(writes(seen)) == (1 if action == 'approve' else 0)
    assert [message['payload']['role'] for message in seen if message['op'] == 'model'] == (
        ['parent', 'child', 'child', 'parent'] if action == 'approve' else ['parent', 'child', 'parent']
    )
    if action == 'deny':
        assert seen[-1]['payload']['messages'][-1]['content'] == 'The tool call was denied.'
    else:
        assert re.fullmatch(r'pydantic-ai/[0-9a-f]{64}/\d+/\d+', writes(seen)[0]['effectScope'])


def test_display_omitting_child_call_is_refused_before_publish():
    executor, seen, _ = scenario(interaction=lambda requests: {
        'surfaceId': 'main', 'viewRevision': 'approval-1', 'component': 'tests.Approval/v1', 'props': {},
    })
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8))
    assert error.value.code == 'unsupported'
    assert executor.pending('fixed') is None
    assert writes(seen) == []


def test_hoisting_outside_executor_is_refused_before_transport():
    seen = []

    async def transport(raw):
        seen.append(raw)
        pytest.fail('No transport is allowed outside an executor when hoisting.')

    _bridge.install_transport(transport)
    ctx = RunContext(deps=None, model=GalaxieModel('parent'), usage=RunUsage(), conversation_id='fixed')
    with pytest.raises(GalaxieError) as error:
        asyncio.run(run_child(ctx, Agent(GalaxieModel('child'), output_type=[str, DeferredToolRequests]), 'child', hoist_approvals=True))
    assert error.value.code == 'unsupported'
    assert seen == []


def test_second_hoisting_child_is_refused_before_its_request_or_write():
    async def delegate(ctx, child):
        await run_child(ctx, child, 'child', hoist_approvals=True)
        await run_child(ctx, child, 'second child', key='second', hoist_approvals=True)
        return 'unreachable'

    executor, seen, _ = scenario(delegate=delegate)

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) is None
        assert writes(seen) == []
        with pytest.raises(GalaxieError) as error:
            await executor.run(None, 'fixed', 8, resume=answer(executor))
        assert error.value.code == 'invalid'
        assert executor.pending('fixed') is None

    asyncio.run(run())
    assert len(writes(seen)) == 1
    assert [message['payload']['role'] for message in seen if message['op'] == 'model'] == ['parent', 'child', 'child']


def test_hoisting_grandchild_is_refused_before_grandchild_work():
    grandchild = Agent(GalaxieModel('grandchild'), output_type=[str, DeferredToolRequests])

    async def save(ctx: RunContext, value: int) -> str:
        await run_child(ctx, grandchild, 'grandchild', hoist_approvals=True)
        return 'unreachable'

    executor, seen, _ = scenario(child_tools=[face.Tool(save)])
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8))
    assert error.value.code == 'unsupported'
    assert executor.pending('fixed') is None
    assert writes(seen) == []
    assert [message['payload']['role'] for message in seen] == ['parent', 'child']


@pytest.mark.parametrize('option', ['message_history', 'deferred_tool_results', 'output_type'])
def test_owned_options_and_output_types_are_rejected_before_child_work(option):
    async def delegate(ctx, child):
        options: dict[str, Any] = {option: str if option == 'output_type' else None}
        await run_child(ctx, child, 'child', hoist_approvals=True, **options)
        return 'unreachable'

    executor, seen, _ = scenario(delegate=delegate)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8))
    assert error.value.code == 'invalid'
    assert [message['payload']['role'] for message in seen] == ['parent']


@pytest.mark.parametrize('output', [[], ()])
def test_empty_output_override_fails_closed_before_child_work(output):
    async def delegate(ctx, child):
        await run_child(ctx, child, 'child', hoist_approvals=True, output_type=output)
        return 'unreachable'

    executor, seen, _ = scenario(delegate=delegate)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8))
    assert error.value.code == 'invalid'
    assert [message['payload']['role'] for message in seen] == ['parent']


@pytest.mark.parametrize('corruption', ['duplicate', 'metadata-key'])
def test_reader_rejects_parent_request_structure_without_position(corruption):
    executor, _, _ = scenario()
    asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8))
    checkpoint, _ = executor._snapshot('fixed')
    requests = face.ConversationTypeAdapter.validate_json(checkpoint).deferred_tool_requests
    assert requests is not None
    if corruption == 'duplicate':
        requests.approvals.append(requests.approvals[0])
    else:
        requests.metadata['not-pending'] = {}
    with pytest.raises(GalaxieError) as error:
        face.hoisted_child_requests(requests)
    assert error.value.code == 'invalid'
