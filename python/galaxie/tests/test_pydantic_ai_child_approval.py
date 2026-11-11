# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import base64
import json
import re
from copy import deepcopy
from typing import Any
from unittest.mock import patch

import pytest
from pydantic_ai import Agent, ApprovalRequired, CallDeferred, Conversation, DeferredToolRequests, DeferredToolResults, RunContext, Tool
from pydantic_ai.messages import ModelRequest, ModelResponse, RetryPromptPart, TextPart, ToolCallPart, ToolReturnPart, UserPromptPart
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


def scenario(*, output_type=None, delegate=None, interaction=display, resume=None, child_tools=None,
             reply=None, parent_tools=None, delegate_approval=False):
    seen = []
    contexts = []
    write = capability_tool('save', 'records.save@1', SCHEMA)
    write.requires_approval = True
    child = Agent(GalaxieModel('child'), output_type=[str, DeferredToolRequests] if output_type is None else output_type,
                  tools=child_tools or [write])

    @child.output_validator
    def remember(ctx: RunContext, output: Any) -> Any:
        contexts.append(ctx)
        return output

    async def delegate_tool(ctx: RunContext) -> str:
        if delegate is not None:
            return await delegate(ctx, child)
        result = await run_child(ctx, child, 'child', hoist_approvals=True)
        assert not isinstance(result.output, DeferredToolRequests)
        return result.output

    # The public registration name is the one used in the model fixture.
    parent = Agent(GalaxieModel('parent'), output_type=[str, DeferredToolRequests], tools=[
        Tool(delegate_tool, name='delegate', requires_approval=delegate_approval), *(parent_tools or []),
    ])

    async def transport(raw):
        message = json.loads(raw)
        seen.append(message)
        payload = message['payload']
        response: Any
        if message['op'] == 'capability':
            response = 'saved'
        elif payload['role'] == 'parent':
            response = {'content': 'parent-done'} if payload['messages'][-1]['role'] == 'tool' else {
                'content': '', 'toolCalls': [call()],
            }
        else:
            response = {'content': 'child-done'} if payload['messages'][-1]['role'] == 'tool' else {
                'content': '', 'toolCalls': [call('save', 'save', '{"value":2}')],
            }
        if reply is not None:
            response = reply(message, seen, response)
        if message['op'] == 'model' and payload['options'].get('stream'):
            chunk = {'content': response['content']}
            if response.get('toolCalls'):
                chunk['toolCalls'] = [{**part, 'index': index} for index, part in enumerate(response['toolCalls'])]
            _bridge.receive_model_chunk(json.dumps({**message, 'kind': 'notify', 'op': 'model-chunk', 'payload': chunk}))
            await asyncio.sleep(0)
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': response})

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

    executor, seen, _ = scenario(child_tools=[Tool(save)])
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


@pytest.mark.parametrize('output', [str, [str], str | int])
def test_child_without_deferred_output_type_is_refused_before_its_request(output):
    executor, seen, _ = scenario(output_type=output)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8))
    assert error.value.code == 'invalid'
    assert [message['payload']['role'] for message in seen] == ['parent']


@pytest.mark.parametrize('output', [str | DeferredToolRequests, [str, DeferredToolRequests]])
def test_list_and_union_deferred_output_types_can_hoist(output):
    executor, seen, _ = scenario(output_type=output)
    assert asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8)) is None
    assert executor.pending('fixed') is not None
    assert writes(seen) == []


def test_without_flag_child_deferral_stays_tool_data():
    async def delegate(ctx, child):
        result = await run_child(ctx, child, 'child')
        assert isinstance(result.output, DeferredToolRequests)
        return 'deferred tool data'

    executor, seen, _ = scenario(delegate=delegate)
    assert asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8)) == 'parent-done'
    assert executor.pending('fixed') is None
    assert writes(seen) == []
    assert len(seen) == 3


@pytest.mark.parametrize('shape', ['two-approvals', 'external', 'oversize'])
def test_unsupported_child_shapes_never_publish_or_execute_a_gate(shape):
    async def external(value: int) -> str:
        raise CallDeferred()

    def reply(message, seen, response):
        if message['op'] == 'model' and message['payload']['role'] == 'child':
            if shape == 'two-approvals':
                response['toolCalls'].append(call('save', 'save-sibling', '{"value":3}'))
            elif shape == 'oversize':
                response['content'] = 'x' * (128 * 1024)
        return response

    executor, seen, _ = scenario(reply=reply, child_tools=[Tool(external, name='save')] if shape == 'external' else None)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8))
    assert error.value.code == 'unsupported'
    assert str(error.value) == 'This operation is unsupported.'
    assert executor.pending('fixed') is None
    assert writes(seen) == []


def test_two_parallel_delegate_pauses_are_refused_before_interaction_factory():
    factories = []

    def reply(message, seen, response):
        if message['op'] == 'model' and message['payload']['role'] == 'parent':
            response['toolCalls'].append(call(identifier='delegate-sibling'))
        return response

    def interaction(requests):
        factories.append(requests)
        return display(requests)

    executor, seen, _ = scenario(reply=reply, interaction=interaction)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8))
    assert error.value.code == 'unsupported'
    assert factories == []
    assert executor.pending('fixed') is None
    assert writes(seen) == []


def test_parent_gate_beside_delegate_shares_one_all_or_nothing_approval():
    parent_writes = []

    def gate() -> str:
        parent_writes.append('parent')
        return 'parent-saved'

    def reply(message, seen, response):
        if message['op'] == 'model' and message['payload']['role'] == 'parent' and response.get('toolCalls'):
            response['toolCalls'].append(call('gate', 'parent-gate'))
        return response

    executor, seen, _ = scenario(reply=reply, parent_tools=[Tool(gate, requires_approval=True)])

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) is None
        pending = executor.pending('fixed')
        assert pending is not None
        assert len(pending['value']['props']['calls']) == 2
        assert writes(seen) == parent_writes == []
        assert await executor.run(None, 'fixed', 8, resume=answer(executor, identifiers=['delegate', 'parent-gate'])) == 'parent-done'

    asyncio.run(run())
    assert parent_writes == ['parent']
    assert len(writes(seen)) == 1


def test_plain_child_sibling_is_not_replayed_when_gate_resumes():
    plain_calls = []

    def plain() -> str:
        plain_calls.append('plain')
        return 'plain-done'

    write = capability_tool('save', 'records.save@1', SCHEMA)
    write.requires_approval = True

    def reply(message, seen, response):
        if message['op'] == 'model' and message['payload']['role'] == 'child' and response.get('toolCalls'):
            response['toolCalls'].append(call('plain', 'plain'))
        return response

    executor, seen, _ = scenario(reply=reply, child_tools=[write, Tool(plain)])

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) is None
        assert plain_calls == ['plain']
        checkpoint, _ = executor._snapshot('fixed')
        child = json.loads(json.loads(checkpoint)['deferred_tool_requests']['metadata']['delegate'][RESERVED]['state'])
        assert child['messages'][-1]['kind'] == 'request'
        assert child['messages'][-1]['parts'][0]['tool_call_id'] == 'plain'
        assert await executor.run(None, 'fixed', 8, resume=answer(executor)) == 'parent-done'

    asyncio.run(run())
    assert plain_calls == ['plain']
    assert len(writes(seen)) == 1


@pytest.mark.parametrize('metadata', ['missing', 'junk', 'foreign', 'mutated'])
def test_executor_replaces_callback_metadata_with_validated_child_state(metadata):
    def callback(requests, action, payload):
        if metadata == 'missing':
            return DeferredToolResults(approvals={'delegate': True})
        stored = requests.metadata['delegate'][RESERVED]
        if metadata == 'foreign':
            stored['identity'] = 'f' * 64
        elif metadata == 'mutated':
            stored.clear()
        return DeferredToolResults(approvals={'delegate': True}, metadata={'delegate': {RESERVED: 'junk' if metadata == 'junk' else stored}})

    executor, seen, _ = scenario(resume=callback)

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) is None
        assert await executor.run(None, 'fixed', 8, resume=answer(executor)) == 'parent-done'

    asyncio.run(run())
    assert len(writes(seen)) == 1


def test_callback_denial_never_reenters_child_and_discards_its_metadata():
    def callback(requests, action, payload):
        return DeferredToolResults(approvals={'delegate': False}, metadata=requests.metadata)

    executor, seen, _ = scenario(resume=callback)

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) is None
        assert await executor.run(None, 'fixed', 8, resume=answer(executor)) == 'parent-done'

    asyncio.run(run())
    assert writes(seen) == []
    assert executor.pending('fixed') is None
    assert RESERVED not in json.dumps(json.loads(executor._snapshot('fixed')[0])['deferred_tool_requests'])


def test_mutating_interaction_factory_cannot_replace_authoritative_state():
    def interaction(requests):
        value = display(requests)
        requests.metadata['delegate'][RESERVED]['identity'] = 'f' * 64
        return value

    executor, seen, _ = scenario(interaction=interaction)

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) is None
        assert await executor.run(None, 'fixed', 8, resume=answer(executor)) == 'parent-done'

    asyncio.run(run())
    assert len(writes(seen)) == 1


@pytest.fixture(scope='module')
def paused_snapshot():
    executor, seen, _ = scenario()
    assert asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8)) is None
    assert writes(seen) == []
    return executor._snapshot('fixed')


def message_json(message):
    return json.loads(face.ConversationTypeAdapter.dump_json(Conversation(messages=[message])))['messages'][0]


CORRUPTIONS = [
    'non-object-payload', 'missing-field', 'extra-field', 'wrong-version', 'boolean-version', 'string-version', 'long-key', 'non-string-key',
    'non-hex-identity', 'non-json-state', 'non-string-state', 'oversize-state', 'oversize-utf8-state', 'conversation-mismatch', 'foreign-position',
    'missing-state-field', 'extra-state-field', 'no-deferred', 'external-call', 'two-approvals',
    'missing-call', 'duplicate-response-id', 'trailing-response', 'trailing-user', 'two-trailing',
    'trailing-pending-return', 'trailing-pending-retry', 'trailing-unknown-return',
    'empty-child-id', 'long-child-id', 'child-metadata-key', 'nested-payload', 'non-json-projection',
    'non-approval-parent', 'two-payloads', 'duplicate-parent-id', 'parent-metadata-key',
]


def corrupted_snapshot(checkpoint, corruption):
    raw = json.loads(checkpoint)
    parent_requests = raw['deferred_tool_requests']
    entry = parent_requests['metadata']['delegate'][RESERVED]
    state = json.loads(entry['state'])
    requests = state['deferred_tool_requests']
    if corruption == 'non-object-payload':
        parent_requests['metadata']['delegate'][RESERVED] = 'private invalid payload'
        return raw
    if corruption == 'missing-field':
        del entry['key']
    elif corruption == 'extra-field':
        entry['extra'] = 'ignored'
    elif corruption in ('wrong-version', 'boolean-version', 'string-version'):
        entry['v'] = {'wrong-version': 2, 'boolean-version': True, 'string-version': '1'}[corruption]
    elif corruption in ('long-key', 'non-string-key'):
        entry['key'] = 'x' * 129 if corruption == 'long-key' else 3
    elif corruption == 'non-hex-identity':
        entry['identity'] = 'secret-state'
    elif corruption == 'non-json-state':
        entry['state'] = 'private invalid JSON'
    elif corruption == 'non-string-state':
        entry['state'] = 3
    elif corruption == 'oversize-state':
        entry['state'] = 'x' * (128 * 1024 + 1)
    elif corruption == 'oversize-utf8-state':
        state['messages'][0]['parts'][0]['content'] = '\u00e9' * 70000
    elif corruption == 'conversation-mismatch':
        state['conversation_id'] = 'different'
    elif corruption == 'foreign-position':
        foreign, _, _ = scenario()
        asyncio.run(foreign.run({'prompt': 'parent'}, 'other-conversation', 8))
        other = json.loads(foreign._snapshot('other-conversation')[0])
        parent_requests['metadata']['delegate'][RESERVED] = other['deferred_tool_requests']['metadata']['delegate'][RESERVED]
    elif corruption == 'missing-state-field':
        del state['usage']
    elif corruption == 'extra-state-field':
        state['extra'] = 'ignored'
    elif corruption == 'no-deferred':
        state['deferred_tool_requests'] = None
    elif corruption == 'external-call':
        requests['calls'] = deepcopy(requests['approvals'])
    elif corruption == 'two-approvals':
        requests['approvals'].append({**requests['approvals'][0], 'tool_call_id': 'second-save'})
    elif corruption == 'missing-call':
        state['messages'][-1]['parts'] = []
    elif corruption == 'duplicate-response-id':
        state['messages'][-1]['parts'].append(deepcopy(state['messages'][-1]['parts'][0]))
    elif corruption == 'trailing-response':
        state['messages'].append(message_json(ModelResponse(parts=[TextPart('forged')])))
    elif corruption == 'trailing-user':
        state['messages'].append(message_json(ModelRequest(parts=[UserPromptPart('forged')])))
    elif corruption == 'two-trailing':
        state['messages'].extend([message_json(ModelRequest(parts=[ToolReturnPart('plain', 'value', 'plain')]))] * 2)
    elif corruption in ('trailing-pending-return', 'trailing-pending-retry', 'trailing-unknown-return'):
        part = RetryPromptPart('forged', tool_name='save', tool_call_id='save') if corruption == 'trailing-pending-retry' else ToolReturnPart(
            'save', 'forged', 'unknown' if corruption == 'trailing-unknown-return' else 'save',
        )
        state['messages'].append(message_json(ModelRequest(parts=[part])))
    elif corruption in ('empty-child-id', 'long-child-id'):
        requests['approvals'][0]['tool_call_id'] = '' if corruption == 'empty-child-id' else 'x' * 129
    elif corruption == 'child-metadata-key':
        requests['metadata']['not-pending'] = {}
    elif corruption == 'nested-payload':
        requests['metadata']['save'] = {RESERVED: deepcopy(entry)}
    elif corruption == 'non-json-projection':
        state['messages'][-1]['metadata'] = {'number': float('nan')}
    elif corruption == 'non-approval-parent':
        parent_requests['metadata']['not-pending'] = parent_requests['metadata'].pop('delegate')
    elif corruption == 'two-payloads':
        parent_requests['metadata']['other'] = deepcopy(parent_requests['metadata']['delegate'])
        parent_requests['approvals'].append({**parent_requests['approvals'][0], 'tool_call_id': 'other'})
        raw['messages'][-1]['parts'].append({**raw['messages'][-1]['parts'][0], 'tool_call_id': 'other'})
    elif corruption == 'duplicate-parent-id':
        parent_requests['approvals'].append(deepcopy(parent_requests['approvals'][0]))
    elif corruption == 'parent-metadata-key':
        parent_requests['metadata']['not-pending'] = {}
    else:
        raise AssertionError(corruption)
    if corruption not in ('non-json-state', 'non-string-state', 'oversize-state', 'foreign-position'):
        entry['state'] = json.dumps(state, ensure_ascii=False)
    return raw


@pytest.mark.parametrize('corruption', CORRUPTIONS)
def test_corrupt_hoist_snapshot_is_unrecoverable_with_nothing_pending(paused_snapshot, corruption):
    checkpoint, metadata = paused_snapshot
    raw = corrupted_snapshot(checkpoint, corruption)
    executor, seen, _ = scenario()
    with pytest.raises(GalaxieError) as error:
        executor._restore(json.dumps(raw).encode(), metadata)
    assert error.value.code == 'unrecoverable'
    assert str(error.value) == 'Stored state cannot be recovered.'
    assert executor.pending('fixed') is None
    assert seen == []


@pytest.mark.parametrize('corruption', CORRUPTIONS)
def test_manual_corrupt_hoist_is_refused_at_publish(paused_snapshot, corruption):
    checkpoint, _ = paused_snapshot
    raw = corrupted_snapshot(checkpoint, corruption)
    supplied = raw['deferred_tool_requests']

    async def delegate(ctx, child):
        raise ApprovalRequired(metadata={})

    executor, seen, _ = scenario(delegate=delegate)
    original_run = executor.agent.run

    async def doctored(*args, **kwargs):
        result = await original_run(*args, **kwargs)
        assert isinstance(result.output, DeferredToolRequests)
        result.output.metadata = supplied['metadata']
        result.output.approvals = [ToolCallPart(part['tool_name'], part['args'], tool_call_id=part['tool_call_id'])
                                   for part in supplied['approvals']]
        return result

    with patch.object(executor.agent, 'run', doctored):
        with pytest.raises(GalaxieError) as error:
            asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8))
    assert error.value.code == 'unsupported'
    assert str(error.value) == 'This operation is unsupported.'
    assert executor.pending('fixed') is None
    assert writes(seen) == []


@pytest.mark.parametrize('shape', ['scattered', 'wrong-id', 'wrong-name', 'wrong-arguments', 'stringified'])
def test_child_call_must_be_present_together_in_display_props(shape):
    def interaction(requests):
        value = display(requests)
        shown = value['props']['calls'][0]['child'][0]
        if shape == 'scattered':
            value['props'] = {'fields': [{key: item} for key, item in shown.items()]}
        elif shape == 'stringified':
            value['props'] = {'text': json.dumps(shown)}
        else:
            shown[{'wrong-id': 'id', 'wrong-name': 'name', 'wrong-arguments': 'arguments'}[shape]] = 'different'
        return value

    executor, seen, _ = scenario(interaction=interaction)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8))
    assert error.value.code == 'unsupported'
    assert executor.pending('fixed') is None
    assert writes(seen) == []


def test_display_accepts_equivalent_json_object_arguments():
    def interaction(requests):
        value = display(requests)
        value['props']['calls'][0]['child'][0]['arguments'] = {'value': 2}
        return value

    executor, seen, _ = scenario(interaction=interaction)
    assert asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8)) is None
    assert executor.pending('fixed') is not None
    assert writes(seen) == []


def test_changed_child_arguments_break_stored_display_binding(paused_snapshot):
    checkpoint, metadata = paused_snapshot
    raw = json.loads(checkpoint)
    entry = raw['deferred_tool_requests']['metadata']['delegate'][RESERVED]
    state = json.loads(entry['state'])
    state['deferred_tool_requests']['approvals'][0]['args'] = '{"value":99}'
    state['messages'][-1]['parts'][0]['args'] = '{"value":99}'
    entry['state'] = json.dumps(state)
    restored, seen, _ = scenario()
    with pytest.raises(GalaxieError) as error:
        restored._restore(json.dumps(raw).encode(), metadata)
    assert error.value.code == 'unrecoverable'
    assert restored.pending('fixed') is None
    assert seen == []


def test_unrelated_author_metadata_remains_author_owned(paused_snapshot):
    checkpoint, metadata = paused_snapshot
    raw = json.loads(checkpoint)
    raw['deferred_tool_requests']['metadata']['delegate']['author-child-state'] = {'arbitrary': ['unvalidated']}
    restored, seen, _ = scenario()
    assert restored._restore(json.dumps(raw).encode(), metadata) == 'fixed'
    assert restored.pending('fixed') is not None
    assert seen == []


@pytest.mark.parametrize('misuse', ['key', 'state'])
def test_reentry_validation_fails_invalid_before_any_gated_body(misuse):
    key = ['first']

    async def delegate(ctx, child):
        if misuse == 'state' and ctx.tool_call_approved:
            ctx.tool_call_metadata[RESERVED]['state'] = 'invalid private state'
        result = await run_child(ctx, child, 'child', key=key[0], hoist_approvals=True)
        return result.output

    executor, seen, _ = scenario(delegate=delegate)

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) is None
        if misuse == 'key':
            key[0] = 'different'
        with pytest.raises(GalaxieError) as error:
            await executor.run(None, 'fixed', 8, resume=answer(executor))
        assert error.value.code == 'invalid'
        assert str(error.value) == 'The request is invalid.'
        assert executor.pending('fixed') is None

    asyncio.run(run())
    assert writes(seen) == []


def test_reload_and_replay_keep_one_write_per_attempt_and_identical_scope(paused_snapshot):
    checkpoint, metadata = paused_snapshot
    scopes = []
    for _ in range(2):
        restored, seen, _ = scenario()
        assert restored._restore(checkpoint, metadata) == 'fixed'
        before = restored.pending('fixed')
        assert before is not None
        assert asyncio.run(restored.run(None, 'fixed', 8, resume=answer(restored))) == 'parent-done'
        assert len(writes(seen)) == 1
        scopes.append(writes(seen)[0]['effectScope'])
        assert restored.pending('fixed') is None
    assert scopes[0] == scopes[1]
    assert re.fullmatch(r'pydantic-ai/[0-9a-f]{64}/\d+/\d+', scopes[0])


def test_resumed_child_registration_has_fresh_run_id_and_is_revoked_afterward():
    observations = []

    def reply(message, seen, response):
        active = face._active.get()
        assert active is not None
        observations.append((message['op'], message['payload'].get('role'), active, set(active.run_ids), face._authorized.get()))
        return response

    executor, seen, _ = scenario(reply=reply)

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) is None
        assert await executor.run(None, 'fixed', 8, resume=answer(executor)) == 'parent-done'

    asyncio.run(run())
    old_child = observations[1][4]
    resumed_child = next(item for item in observations[2:] if item[1] == 'child')
    assert old_child is not None and resumed_child[4] is not None and old_child != resumed_child[4]
    assert old_child not in resumed_child[3]
    assert resumed_child[4] in resumed_child[3]
    capability = next(item for item in observations if item[0] == 'capability')
    assert len(capability[3]) == len(resumed_child[3]) == 2
    assert capability[3] == resumed_child[3]
    assert all(item[2].run_ids == set() for item in observations)
    assert face._active.get() is None
    assert len(writes(seen)) == 1


def test_plain_child_resume_cannot_execute_saved_approved_gate():
    async def delegate(ctx, child):
        if ctx.tool_call_approved:
            saved = face.ConversationTypeAdapter.validate_json(ctx.tool_call_metadata[RESERVED]['state'])
            requests = saved.deferred_tool_requests
            assert requests is not None
            await child.run(None, message_history=saved.messages, deferred_tool_results=requests.build_results(approve_all=True))
            return 'unreachable'
        return (await run_child(ctx, child, 'child', hoist_approvals=True)).output

    executor, seen, _ = scenario(delegate=delegate)

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) is None
        with pytest.raises(GalaxieError) as error:
            await executor.run(None, 'fixed', 8, resume=answer(executor))
        assert error.value.code == 'unsupported'

    asyncio.run(run())
    assert writes(seen) == []
    assert [message['payload']['role'] for message in seen] == ['parent', 'child']


@pytest.mark.parametrize('stamp', ['parent', 'child'])
def test_plain_nested_model_run_cannot_borrow_registered_history_stamp(stamp):
    nested = Agent(GalaxieModel('rogue'))

    async def delegate(parent_ctx, child):
        @child.output_validator
        async def nested_request(child_ctx: RunContext, output: str) -> str:
            identifier = parent_ctx.run_id if stamp == 'parent' else child_ctx.run_id
            history = [ModelRequest(parts=[UserPromptPart('nested')], run_id=identifier)]
            await nested.run(None, message_history=history)
            return output

        return (await run_child(parent_ctx, child, 'child', hoist_approvals=True)).output

    executor, seen, _ = scenario(delegate=delegate)

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) is None
        with pytest.raises(GalaxieError) as error:
            await executor.run(None, 'fixed', 8, resume=answer(executor))
        assert error.value.code == 'unsupported'

    asyncio.run(run())
    assert [message['payload']['role'] for message in seen if message['op'] == 'model'] == ['parent', 'child', 'child']
    assert len(writes(seen)) == 1


def test_nested_executor_remains_refused_before_child_transport():
    async def delegate(ctx, child):
        await Executor(child).run({'prompt': 'nested'}, 'nested', 8)
        return 'unreachable'

    executor, seen, _ = scenario(delegate=delegate)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8))
    assert error.value.code == 'unsupported'
    assert [message['payload']['role'] for message in seen] == ['parent']


def test_child_can_pause_again_with_a_new_host_interaction():
    def reply(message, seen, response):
        child_requests = [item for item in seen if item['op'] == 'model' and item['payload']['role'] == 'child']
        if message['op'] == 'model' and message['payload']['role'] == 'child' and len(child_requests) == 2:
            return {'content': '', 'toolCalls': [call('save', 'second-save', '{"value":3}')]}
        return response

    executor, seen, _ = scenario(reply=reply)

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) is None
        first = executor.pending('fixed')
        assert first is not None
        assert await executor.run(None, 'fixed', 8, resume=answer(executor)) is None
        second = executor.pending('fixed')
        assert second is not None and first['id'] != second['id']
        assert second['value']['props']['calls'][0]['child'][0]['id'] == 'second-save'
        assert len(writes(seen)) == 1
        assert await executor.run(None, 'fixed', 8, resume=answer(executor)) == 'parent-done'
        assert executor.pending('fixed') is None

    asyncio.run(run())
    assert [item['input'] for item in writes(seen)] == [{'value': 2}, {'value': 3}]
    assert len({item['effectScope'] for item in writes(seen)}) == 2


def test_gated_delegate_needs_its_own_approval_then_child_approval():
    executor, seen, _ = scenario(delegate_approval=True)

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) is None
        first = executor.pending('fixed')
        assert first is not None
        assert first['value']['props']['calls'][0]['child'] == []
        assert [message['payload']['role'] for message in seen] == ['parent']
        assert await executor.run(None, 'fixed', 8, resume=answer(executor)) is None
        second = executor.pending('fixed')
        assert second is not None and first['id'] != second['id']
        assert second['value']['props']['calls'][0]['child'][0]['name'] == 'save'
        assert writes(seen) == []
        assert await executor.run(None, 'fixed', 8, resume=answer(executor)) == 'parent-done'

    asyncio.run(run())
    assert len(writes(seen)) == 1


def test_shared_usage_counts_child_requests_once_across_pause():
    executor, _, _ = scenario()

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) is None
        before = face.ConversationTypeAdapter.validate_json(executor._snapshot('fixed')[0])
        assert before.usage.requests == 2
        assert await executor.run(None, 'fixed', 8, resume=answer(executor)) == 'parent-done'
        after = face.ConversationTypeAdapter.validate_json(executor._snapshot('fixed')[0])
        assert after.usage.requests == 4

    asyncio.run(run())


def test_step_budget_can_end_inside_resumed_child():
    def plain() -> str:
        return 'plain-done'

    write = capability_tool('save', 'records.save@1', SCHEMA)
    write.requires_approval = True

    def reply(message, seen, response):
        if message['op'] == 'model' and message['payload']['role'] == 'child' and response['content'] == 'child-done':
            return {'content': '', 'toolCalls': [call('plain', 'plain')]}
        return response

    executor, seen, _ = scenario(reply=reply, child_tools=[write, Tool(plain)])

    async def run():
        assert await executor.run({'prompt': 'parent'}, 'fixed', 8) is None
        with pytest.raises(GalaxieError) as error:
            await executor.run(None, 'fixed', 1, resume=answer(executor))
        assert error.value.code == 'budget_exceeded'
        assert executor.pending('fixed') is None

    asyncio.run(run())
    assert len(writes(seen)) == 1
    assert [message['payload']['role'] for message in seen if message['op'] == 'model'] == ['parent', 'child', 'child']


def test_parent_streaming_publishes_the_hoisted_deferred_marker():
    executor, seen, _ = scenario()
    events = []
    assert asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8, on_stream=lambda mode, data: events.append((mode, data)))) is None
    assert events[-1] == ('updates', {'kind': 'deferred'})
    assert executor.pending('fixed') is not None
    assert writes(seen) == []
    assert [message['payload']['options'].get('stream', False) for message in seen] == [True, False]


def test_oversize_parent_snapshot_frame_is_refused_before_checkpoint_transport():
    executor, seen, _ = scenario()

    async def run():
        assert await executor.run({'prompt': 'x' * 800000}, 'fixed', 8) is None
        checkpoint, metadata = executor._snapshot('fixed')
        assert len(checkpoint) < _bridge.MAX_BYTES
        payload = {
            'op': 'put', 'sessionId': 'fixed', 'namespace': '', 'id': 'snapshot', 'parentId': None,
            'checkpoint': {'type': 'json', 'bytes': base64.b64encode(checkpoint).decode()},
            'metadata': {'type': 'json', 'bytes': base64.b64encode(metadata).decode()}, 'timestamp': 'fixed',
        }
        assert len(json.dumps(payload).encode()) > _bridge.MAX_BYTES
        with pytest.raises(GalaxieError) as error:
            await _bridge.request('checkpoint', payload)
        assert error.value.code == 'unsupported'

    asyncio.run(run())
    assert [message['op'] for message in seen] == ['model', 'model']
    assert writes(seen) == []
