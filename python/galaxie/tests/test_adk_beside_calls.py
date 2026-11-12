# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Measure shipped confirmation siblings and the long-running input replacement.

The bridge journal below models the host's successful write receipts; it does
not replace a core/broker integration test. Native evidence is recorded in
test_adk_python_confirmation_beside_calls.py. No production seam is installed.

Gate | Observed | Result
GA1 | A1/A2/A3 approve and deny preserve ordered native results | PASS
GA2 | Fresh executors restore the same pause from bytes without rerunning siblings | PASS
GA3 | A4 fake-host receipts survive failed resume/retry; scopes match ungated runs | PASS
GA4 | Partial/wrong-kind answers invoke nothing and leave the pause answerable | PASS
GA5 | Existing unit refusals retained; full conformance goldens not rerun here | incomplete
GB1-GB5 | Native combined answer loses L's result, so no candidate seam is built | not applicable
AL1 | Ordinary long-running capability delivers the input answer to the model | PASS
AL2 | Four-field interaction carries question/schema; resume rejects malformed input | PASS
AL3 | Reserved-name capability also delivers the answer, live and restored | PASS

These are measurement results, not completed support outcomes: adding the
required conformance cases would require changing the existing compatibility
matrix, which is frozen for this run. No runtime behavior or public API changes.
"""

import asyncio
import copy
import json
from collections import Counter

import pytest
from google.adk.agents import LlmAgent

from galaxie import GalaxieError, _bridge
from galaxie.adk import Executor, capability_tool, llm

PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}
SHAPES = [('gated', 'ordinary'), ('ordinary', 'gated'), ('ordinary', 'gated', 'other')]


def tool_call(name, args, index):
    return {'id': f'provider-{index}', 'type': 'function',
            'function': {'name': name, 'arguments': json.dumps(args, separators=(',', ':'))}}


def interaction(requests):
    return {'surfaceId': 'main', 'viewRevision': 'r1', 'component': 'app.Approval/v1',
            'props': {'requests': requests}}


def agent(tools):
    return LlmAgent(name='root', model=llm('answer'), instruction='Use the tools.', tools=tools)


def executor_for(calls, *, confirm=True, **hooks):
    executor = Executor(agent([capability_tool(
        name, f'{name}@1', PARAMETERS, 'Run the operation.',
        require_confirmation=confirm and name.startswith('gated'), long_running=name == 'pending',
    ) for name in calls]), interaction=interaction, **hooks)
    executor.durable = True
    return executor


def run(executor):
    return asyncio.run(executor.run({'prompt': 'question'}, 's1', 5))


def answer(executor, pending, *, action='approve', payload=None):
    return asyncio.run(executor.run(None, 's1', 5, resume={
        'interactionId': pending['id'], 'action': action,
        'payload': {'indexes': [0]} if payload is None else payload,
    }))


def invalid(call):
    with pytest.raises(GalaxieError) as error:
        call()
    assert error.value.code == 'invalid'


class Bridge:
    """Count real host invocations separately from calls replaying a receipt."""

    def __init__(self, calls, *, writes=False):
        self.calls = calls
        self.writes = writes
        self.seen = []
        self.invoked = []
        self.confirmed = []
        self.journal = {}
        self.models = 0
        self.fail_next_model = False

    async def transport(self, raw):
        message = json.loads(raw)
        op, payload = message['op'], message['payload']
        self.seen.append((op, payload))
        if op == 'model':
            self.models += 1
            if self.models == 1:
                reply = {'content': '', 'toolCalls': [tool_call(name, {'value': index + 1}, index)
                                                     for index, name in enumerate(self.calls)]}
            elif self.fail_next_model:
                self.fail_next_model = False
                return json.dumps({
                    'v': message['v'], 'id': message['id'], 'op': op,
                    'kind': 'response', 'ok': False, 'error': {'code': 'unavailable'},
                })
            else:
                reply = {'content': 'done'}
        else:
            assert op == 'capability'
            scope = payload['effectScope']
            logical = (payload['name'], payload['input'])
            if self.writes and scope in self.journal:
                previous, reply = self.journal[scope]
                assert previous == logical
            else:
                if self.writes:
                    self.confirmed.append(logical)
                self.invoked.append((scope, logical))
                reply = {payload['name'].removesuffix('@1'): payload['input']['value']}
                if self.writes:
                    self.journal[scope] = (copy.deepcopy(logical), reply)
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': reply})

    def install(self):
        _bridge.install_transport(self.transport)

    def requests(self):
        return [payload['messages'][1:] for op, payload in self.seen if op == 'model']


def expected_transcript(calls, approved):
    return [
        {'role': 'user', 'content': 'question'},
        {'role': 'assistant', 'content': '', 'toolCalls': [
            {**tool_call(name, {'value': index + 1}, index), 'id': f'galaxie-{index + 1}'}
            for index, name in enumerate(calls)
        ]},
        *[{'role': 'tool', 'tool_call_id': f'galaxie-{index + 1}', 'content': json.dumps(
            {'error': 'This tool call is rejected.'} if name.startswith('gated') and not approved else {name: index + 1},
            separators=(',', ':'),
        )} for index, name in enumerate(calls)],
    ]


@pytest.mark.parametrize('calls', SHAPES)
@pytest.mark.parametrize('approved', [True, False])
@pytest.mark.parametrize('reload', [False, True])
@pytest.mark.parametrize('writes', [False, True])
def test_siblings_retain_native_results_and_scopes_across_live_and_reload(calls, approved, reload, writes):
    bridge = Bridge(calls, writes=writes)
    bridge.install()
    executor = executor_for(calls)
    assert run(executor) is None
    pending = executor.pending('s1')
    assert pending is not None
    assert pending['value'] == interaction([{
        'kind': 'confirmation', 'tool': 'gated', 'args': {'value': calls.index('gated') + 1},
    }])
    assert [logical[0] for _, logical in bridge.invoked] == [f'{name}@1' for name in calls if name != 'gated']
    assert bridge.requests() == [[{'role': 'user', 'content': 'question'}]]
    if reload:
        checkpoint, metadata = executor._snapshot('s1', 'bound')
        del executor
        executor = executor_for(calls)
        assert asyncio.run(executor._restore(checkpoint, metadata, 'bound')) == 's1'
        assert executor.pending('s1') == pending
    assert answer(executor, pending, action='approve' if approved else 'deny') == 'done'
    assert executor.pending('s1') is None
    assert bridge.requests() == [[{'role': 'user', 'content': 'question'}], expected_transcript(calls, approved)]
    assert Counter(logical[0] for _, logical in bridge.invoked) == Counter(
        f'{name}@1' for name in calls if name != 'gated' or approved
    )
    assert sorted(scope for scope, _ in bridge.invoked) == [
        f'adk-python/s1/root/0/{index}' for index, name in enumerate(calls) if name != 'gated' or approved
    ]
    if writes:
        assert len(bridge.confirmed) == len(bridge.invoked) == len(bridge.journal)


@pytest.mark.parametrize('calls', SHAPES)
@pytest.mark.parametrize('reload', [False, True])
def test_an_approved_write_then_model_failure_replays_once_with_ungated_scopes(calls, reload):
    baseline = Bridge(calls, writes=True)
    baseline.install()
    assert run(executor_for(calls, confirm=False)) == 'done'
    bridge = Bridge(calls, writes=True)
    bridge.install()
    executor = executor_for(calls)
    assert run(executor) is None
    pending = executor.pending('s1')
    assert pending is not None
    paused_bytes = executor._snapshot('s1', 'bound')
    bridge.fail_next_model = True
    with pytest.raises(GalaxieError) as error:
        answer(executor, pending)
    assert error.value.code == 'unavailable'
    assert executor.pending('s1') == pending
    assert executor._snapshot('s1', 'bound') == paused_bytes
    if reload:
        del executor
        executor = executor_for(calls)
        assert asyncio.run(executor._restore(*paused_bytes, 'bound')) == 's1'
        assert executor.pending('s1') == pending
    assert answer(executor, pending) == 'done'
    assert len(bridge.invoked) == len(bridge.confirmed) == len(calls)
    assert sorted(bridge.invoked) == sorted(baseline.invoked)
    assert bridge.requests()[-2:] == [expected_transcript(calls, True)] * 2


@pytest.mark.parametrize('wrong_kind', [False, True])
def test_partial_or_wrong_kind_answers_run_nothing_and_keep_the_pause_answerable(wrong_kind):
    calls = ('ordinary', 'gated', 'gated_other')
    bridge = Bridge(calls)
    bridge.install()
    resume = (lambda requests, action, payload: (
        [{'response': {}} for _ in requests] if action == 'wrong' else [{'confirmed': True} for _ in requests]
    )) if wrong_kind else None
    executor = executor_for(calls, resume=resume)
    assert run(executor) is None
    pending = executor.pending('s1')
    assert pending is not None
    assert len(pending['value']['props']['requests']) == 2
    before = copy.deepcopy(bridge.seen)
    invalid(lambda: answer(executor, pending, action='wrong' if wrong_kind else 'approve', payload={'indexes': [0]}))
    assert bridge.seen == before
    assert executor.pending('s1') == pending
    assert answer(executor, pending, payload={'indexes': [0, 1]}) == 'done'
    assert Counter(logical[0] for _, logical in bridge.invoked) == Counter(f'{name}@1' for name in calls)


@pytest.mark.parametrize('calls', [('gated', 'pending'), ('pending', 'gated')])
def test_long_running_siblings_stay_refused_before_any_host_call(calls):
    bridge = Bridge(calls)
    bridge.install()
    executor = executor_for(calls)
    with pytest.raises(GalaxieError) as error:
        run(executor)
    assert error.value.code == 'unsupported'
    assert executor.pending('s1') is None
    assert bridge.invoked == []
    assert executor._sessions.sessions['galaxie']['galaxie']['s1'].events == []


@pytest.mark.parametrize('name', ['ask_city', 'adk_request_input'])
@pytest.mark.parametrize('reload', [False, True])
def test_long_running_input_replacement_validates_answers_including_the_reserved_name(name, reload):
    question = {'message': 'Which city?', 'response_schema': {
        'type': 'object', 'properties': {'city': {'type': 'string'}}, 'required': ['city'],
    }}
    requests = []
    seen = []
    replies = iter([
        {'content': '', 'toolCalls': [tool_call(name, question, 0)]}, {'pending': True}, {'content': 'done'},
    ])

    async def transport(raw):
        message = json.loads(raw)
        seen.append((message['op'], message['payload']))
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': next(replies)})

    def resume(asks, action, payload):
        if action != 'submit' or type(payload) is not dict or set(payload) != {'city'} or type(payload['city']) is not str or not payload['city']:
            raise GalaxieError('invalid')
        assert asks == [{'kind': 'long-running', 'tool': name, 'args': question}]
        return [{'response': payload}]

    def build():
        tool = capability_tool(name, 'question.ask@1', {
            'type': 'object', 'properties': {'message': {'type': 'string'}, 'response_schema': {'type': 'object'}},
            'required': ['message', 'response_schema'],
        }, 'Ask for a city.', long_running=True)
        executor = Executor(agent([tool]), interaction=lambda asks: (requests.append(asks), interaction(asks))[1], resume=resume)
        executor.durable = True
        return executor

    _bridge.install_transport(transport)
    executor = build()
    assert run(executor) is None
    pending = executor.pending('s1')
    assert pending is not None
    assert set(pending['value']) == {'surfaceId', 'viewRevision', 'component', 'props'}
    assert len(requests) == 1
    assert pending['value']['props']['requests'] == requests[0]
    assert requests[0] == [{'kind': 'long-running', 'tool': name, 'args': question}]
    if reload:
        saved = executor._snapshot('s1', 'bound')
        del executor
        executor = build()
        assert asyncio.run(executor._restore(*saved, 'bound')) == 's1'
        assert executor.pending('s1') == pending
        assert len(requests) == 1
    before = copy.deepcopy(seen)
    for payload in ({}, {'city': 1}, {'city': ''}, {'city': 'Hue', 'extra': True}):
        invalid(lambda: answer(executor, pending, action='submit', payload=payload))
        assert executor.pending('s1') == pending
        assert seen == before
    assert answer(executor, pending, action='submit', payload={'city': 'Hue'}) == 'done'
    assert [op for op, _ in seen] == ['model', 'capability', 'model']
    assert seen[-1][1]['messages'][-1] == {
        'role': 'tool', 'tool_call_id': 'galaxie-1', 'content': '{"city":"Hue"}',
    }
