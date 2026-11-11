# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
from typing import Any

import pytest
from pydantic_ai import Agent, DeferredToolRequests, RunContext, Tool

from galaxie import _bridge
from galaxie.pydantic_ai import Executor, GalaxieModel, hoisted_child_requests, run_child


# Probe S1: exposing child output requires a stable path, a capability change and
# an ADR-0018 revision together with these parent-only stream assertions.
def child_projection(notifications: list[str]) -> list[str]:
    violations = []
    requests = []
    for raw in notifications:
        message = json.loads(raw)
        if message['op'] != 'stream':
            continue
        path, mode, data = message['payload']
        if path != []:
            violations.append('non-empty path')
        if 'child-' in json.dumps(data):
            violations.append('child text')
        if mode == 'updates':
            if data['kind'] == 'model-request':
                requests.append(data['index'])
            elif data['kind'] == 'tool-call' and data != {'kind': 'tool-call', 'name': 'delegate', 'index': 0}:
                violations.append('child tool')
    if requests != list(range(len(requests))) or len(requests) > 2:
        violations.append('child model request')
    return violations


def display(requests: DeferredToolRequests) -> dict[str, Any]:
    children = hoisted_child_requests(requests)
    return {
        'surfaceId': 'main', 'viewRevision': 'approval-1', 'component': 'tests.Approval/v1',
        'props': {'calls': [
            {'id': part.tool_call_id, 'name': part.tool_name, 'arguments': part.args_as_json_str(),
             'child': [{'id': child.tool_call_id, 'name': child.tool_name, 'arguments': child.args_as_json_str()}
                       for child in children[part.tool_call_id].approvals]}
            for part in requests.approvals
        ]},
    }


def scenario(*, hoist: bool = False) -> tuple[Executor, list[dict[str, Any]], list[str]]:
    seen: list[dict[str, Any]] = []
    notifications: list[str] = []

    def call(name: str) -> dict[str, Any]:
        return {'id': name, 'type': 'function', 'function': {'name': name, 'arguments': '{}'}}

    async def transport(raw: str) -> str:
        message = json.loads(raw)
        seen.append(message)
        payload = message['payload']
        role = payload['role']
        final = payload['messages'][-1]['role'] == 'tool'
        reply: dict[str, Any] = {'content': f'{role}-done'} if final else {
            'content': '' if role == 'parent' else 'child-step',
            'toolCalls': [call('delegate' if role == 'parent' else 'child_step')],
        }
        if payload['options'].get('stream'):
            chunk = {'content': reply['content']}
            if reply.get('toolCalls'):
                chunk['toolCalls'] = [{**part, 'index': index} for index, part in enumerate(reply['toolCalls'])]
            _bridge.receive_model_chunk(json.dumps({
                **message, 'kind': 'notify', 'op': 'model-chunk', 'payload': chunk,
            }))
            await asyncio.sleep(0)
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})

    _bridge.install_transport(transport, notifications.append)

    def child_step() -> str:
        return 'child tool result'

    child = Agent(GalaxieModel('child'), output_type=[str, DeferredToolRequests], tools=[
        Tool(child_step, requires_approval=hoist),
    ])
    parent = Agent(GalaxieModel('parent'), output_type=[str, DeferredToolRequests])

    @parent.tool
    async def delegate(ctx: RunContext) -> str:
        result = await run_child(ctx, child, 'child', hoist_approvals=hoist)
        assert isinstance(result.output, str)
        return 'delegated'

    return Executor(parent, interaction=display), seen, notifications


@pytest.mark.parametrize('hoist', [False, True])
def test_delegation_streams_only_parent_events_with_empty_paths(hoist: bool) -> None:
    executor, seen, notifications = scenario(hoist=hoist)
    output = asyncio.run(executor.run(
        {'prompt': 'parent'}, 'fixed', 8,
        on_stream=lambda mode, data: _bridge.notify_stream([], mode, data),
    ))
    payloads = [json.loads(raw)['payload'] for raw in notifications if json.loads(raw)['op'] == 'stream']
    assert payloads
    assert child_projection(notifications) == []
    assert all(path == [] for path, _, _ in payloads)
    assert [data for _, mode, data in payloads if mode == 'updates'] == (
        [{'kind': 'model-request', 'index': 0}, {'kind': 'tool-call', 'name': 'delegate', 'index': 0},
         {'kind': 'deferred'}] if hoist else
        [{'kind': 'model-request', 'index': 0}, {'kind': 'tool-call', 'name': 'delegate', 'index': 0},
         {'kind': 'model-request', 'index': 1}]
    )
    text = ''.join(data[0]['content'] for _, mode, data in payloads if mode == 'messages')
    assert text == ('' if hoist else 'parent-done')
    assert output == (None if hoist else 'parent-done')
    assert (executor.pending('fixed') is not None) == hoist
    children = [message for message in seen if message['payload']['role'] == 'child']
    assert len(children) == (1 if hoist else 2)
    assert all('stream' not in message['payload']['options'] for message in children)


@pytest.mark.parametrize('projection', ['text', 'path', 'tool', 'request'])
def test_child_projection_detector_observes_wire_notifications(projection: str) -> None:
    _, _, notifications = scenario()
    if projection == 'text':
        _bridge.notify_stream([], 'messages', [{'type': 'ai', 'content': 'child-done'}, {}])
    elif projection == 'path':
        _bridge.notify_stream(['child'], 'updates', {'kind': 'model-request', 'index': 0})
    elif projection == 'tool':
        _bridge.notify_stream([], 'updates', {'kind': 'tool-call', 'name': 'child_step', 'index': 0})
    else:
        _bridge.notify_stream([], 'updates', {'kind': 'model-request', 'index': 2})
    assert child_projection(notifications)


def test_delegation_without_stream_callback_emits_no_notifications() -> None:
    executor, _, notifications = scenario()
    assert asyncio.run(executor.run({'prompt': 'parent'}, 'fixed', 8)) == 'parent-done'
    assert notifications == []
