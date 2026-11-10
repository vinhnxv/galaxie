# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import hashlib
import inspect
import json
from pathlib import Path
from copy import deepcopy

import pydantic_ai
import pytest
from pydantic_ai.exceptions import UserError
from delegation import factory
from galaxie import GalaxieError, _bridge
from galaxie.pydantic_ai import GalaxieModel

@pytest.fixture(autouse=True)
def restore_transport(monkeypatch):
    # install_transport has no public uninstall; restore the prior test boundary.
    monkeypatch.setattr(_bridge, '_transport', _bridge._transport)


SPECS = json.loads(Path(__file__).with_name('fixtures.json').read_text())


class Transport:
    def __init__(self, name, delegate_id=None):
        self.spec = deepcopy(SPECS[name])
        if delegate_id is not None:
            for reply in self.spec['scripts']['parent']:
                for call in reply.get('toolCalls', []):
                    if call['name'] == 'delegate':
                        call['id'] = delegate_id
        self.seen = []
        _bridge.install_transport(self.request)

    async def request(self, raw):
        message = json.loads(raw)
        self.seen.append(message)
        payload = message['payload']
        if message['op'] == 'model':
            messages = payload['messages']
            prompt = next(item['content'] for item in messages if item['role'] == 'user')
            index = sum(item['role'] == 'assistant' for item in messages)
            script = self.spec['scripts'][prompt]
            assert index < len(script), 'The scripted request sequence was exhausted.'
            reply = script[index]
            result = {'content': reply['text'], 'usage': {
                'input_tokens': 2, 'output_tokens': 2, 'total_tokens': 4,
            }}
            if reply.get('toolCalls'):
                result['toolCalls'] = [
                    {'id': call['id'], 'type': 'function', 'function': {
                        'name': call['name'], 'arguments': json.dumps(call['args']),
                    }} for call in reply['toolCalls']]
        else:
            assert message['op'] == 'capability'
            result = {'value': payload['input']['value'] * 2}
        return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': result})

    @property
    def models(self):
        return [item['payload'] for item in self.seen if item['op'] == 'model']

    @property
    def capabilities(self):
        return [item['payload'] for item in self.seen if item['op'] == 'capability']


def execute(name, variant='helper', steps=20):
    transport = Transport(name)
    executor = factory(name, variant)
    result = asyncio.run(executor.run({'prompt': transport.spec['prompt']}, 'conversation', steps))
    return executor, transport, result


def answer(executor, ids, **extra):
    pending = executor.pending('conversation')
    assert pending is not None
    return {'interactionId': pending['id'], 'action': 'approve',
            'payload': {'toolCallIds': ids, **extra}}


def test_smoke():
    _, transport, result = execute('smoke')
    assert result == 'done'
    assert len(transport.models) == 1


@pytest.mark.parametrize('variant', ['plain', 'usage', 'conv'])
def test_d2_plain_nested_runs_are_refused_before_child_requests(variant):
    transport = Transport('steps')
    with pytest.raises(GalaxieError) as error:
        asyncio.run(factory('steps', variant).run({'prompt': 'parent'}, 'conversation', 3))
    assert error.value.code == 'unsupported'
    assert [item['role'] for item in transport.models] == ['answer']
    assert transport.capabilities == []


def test_d2_helper_shares_the_parent_step_budget():
    transport = Transport('steps')
    with pytest.raises(GalaxieError) as error:
        asyncio.run(factory('steps').run({'prompt': 'parent'}, 'conversation', 3))
    assert error.value.code == 'budget_exceeded'
    assert len(transport.models) == 3
    assert transport.capabilities == []


def test_d4_helper_scopes_are_stable_and_disjoint_from_parent():
    observed = []
    for _ in range(2):
        _, transport, result = execute('scopes')
        assert result == 'parent-done'
        assert len(transport.models) == 4
        assert len(transport.capabilities) == 2
        by_value = {item['input']['value']: item['effectScope'] for item in transport.capabilities}
        assert by_value[1] == 'pydantic-ai/conversation/1/0'
        assert by_value[2] != by_value[1]
        observed.append(by_value[2])
    assert observed[0] == observed[1]


def test_replayed_delegate_id_changes_only_the_id_derived_control_scope():
    observed = {}
    for variant in ('helper', 'id-control'):
        scopes = []
        for identifier in ('delegate-original', 'delegate-regenerated'):
            transport = Transport('scopes', delegate_id=identifier)
            result = asyncio.run(factory('scopes', variant).run({'prompt': 'parent'}, 'conversation', 20))
            assert result == 'parent-done'
            scopes.append(next(item['effectScope'] for item in transport.capabilities if item['input']['value'] == 2))
        observed[variant] = scopes
    assert observed['helper'][0] == observed['helper'][1]
    assert observed['id-control'][0] != observed['id-control'][1]
    # The child conversation identity is the scope segment between the slashes.
    assert observed['helper'][0].split('/')[1] == observed['helper'][1].split('/')[1]
    old = hashlib.sha256(json.dumps(['conversation', 'delegate-original']).encode()).hexdigest()
    new = hashlib.sha256(json.dumps(['conversation', 'delegate-regenerated']).encode()).hexdigest()
    assert old != new


def test_d6_native_children_each_start_with_a_fresh_repair_counter():
    _, transport, result = execute('native')
    assert result == 'parent-done'
    assert len(transport.models) == 5
    native = [item for item in transport.models if 'jsonSchema' in item['options']]
    assert [item['options'].get('repairAttempt', 0) for item in native] == [0, 0]


def test_d8_function_model_child_bypasses_bridge_accounting():
    # P1 informational: only the two parent model requests reach the bridge.
    _, transport, result = execute('external', 'plain')
    assert result == 'parent-done'
    assert [item['role'] for item in transport.models] == ['answer', 'answer']
    assert len(transport.capabilities) == 0
    assert 'outside-bridge' in transport.models[1]['messages'][-1]['content']


def test_p1_excluded_deferred_output_fails_without_a_gated_body():
    # P0 pause outcome: a child without DeferredToolRequests errors before gate.
    transport = Transport('excluded-pause')
    with pytest.raises(UserError, match='DeferredToolRequests.*not among output types'):
        asyncio.run(factory('excluded-pause').run({'prompt': 'parent'}, 'conversation', 20))
    assert len(transport.models) == 2
    assert transport.capabilities == []


def test_p2_returned_child_deferral_is_tool_data_without_a_host_pause():
    # P0 pause outcome: no gated body runs, but no host pause is published.
    executor, transport, result = execute('returned-pause')
    assert result == 'parent-done'
    assert executor.pending('conversation') is None
    assert len(transport.models) == 3
    assert transport.capabilities == []
    assert 'child-gate' in transport.models[-1]['messages'][-1]['content']


@pytest.mark.parametrize('variant', ['helper', 'override'])
def test_p3_hoist_preserves_metadata_and_resumes_child_once(variant):
    # P0 pause outcome: explicit metadata forwarding makes the child resumable.
    executor, transport, result = execute('hoist', variant)
    assert result is None
    assert len(transport.models) == 3
    assert [item['input']['value'] for item in transport.capabilities] == [2]
    response = answer(executor, ['delegate'])
    assert asyncio.run(executor.run(None, 'conversation', 20, resume=response)) == 'parent-done'
    assert executor.pending('conversation') is None
    assert len(transport.models) == 5
    assert [item['input']['value'] for item in transport.capabilities] == [2, 3]


def test_p3_default_resume_loses_child_metadata():
    executor, transport, _ = execute('hoist', 'lost-metadata')
    with pytest.raises((KeyError, TypeError)):
        asyncio.run(executor.run(None, 'conversation', 20, resume=answer(executor, ['delegate'])))
    assert len(transport.models) == 3
    assert [item['input']['value'] for item in transport.capabilities] == [2]


def test_p5_parallel_child_pauses_become_one_parent_interaction():
    # P1 informational: two approvals share today's single pending interaction.
    executor, transport, result = execute('parallel-pause', 'helper')
    assert result is None
    pending = executor.pending('conversation')
    assert pending is not None
    assert pending['value']['props']['calls'] == [
        {'id': 'delegate-1', 'name': 'delegate'}, {'id': 'delegate-2', 'name': 'delegate'},
    ]
    assert len(transport.models) == 3
    assert transport.capabilities == []


def test_p6_extra_answer_fields_fail_but_nested_metadata_is_not_validated_at_restore():
    # P1 informational: outer validation does not validate author-owned child state.
    executor, transport, _ = execute('hoist', 'helper')
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run(None, 'conversation', 20,
                                resume=answer(executor, ['delegate'], extra='unexpected')))
    assert error.value.code == 'invalid'
    checkpoint, metadata = executor._snapshot('conversation')
    raw = json.loads(checkpoint)
    raw['deferred_tool_requests']['metadata']['delegate']['child'] = 'corrupt-child-state'
    restored = factory('hoist', 'helper')
    assert restored._restore(json.dumps(raw).encode(), metadata) == 'conversation'
    assert restored.pending('conversation') == executor.pending('conversation')
    assert asyncio.run(restored.run(None, 'conversation', 20,
                                   resume=answer(restored, ['delegate']))) == 'parent-done'
    assert len(transport.models) == 4
    assert [item['input']['value'] for item in transport.capabilities] == [2]


def test_f1_flattened_capability_gate_pauses_and_executes_once():
    # P0 conditional alternative: a single-agent capability gate needs no hoist.
    executor, transport, result = execute('flatten')
    assert result is None
    assert transport.capabilities == []
    assert len(transport.models) == 1
    assert asyncio.run(executor.run(None, 'conversation', 20,
                                   resume=answer(executor, ['flat-gate']))) == 'parent-done'
    assert len(transport.models) == 2
    assert [item['input']['value'] for item in transport.capabilities] == [3]


def test_g1_public_hooks_cover_top_level_resume_parallel_and_sequential_runs():
    # The shipped guard reads public message and tool run identities.
    assert list(inspect.signature(GalaxieModel.request).parameters) == [
        'self', 'messages', 'model_settings', 'model_request_parameters',
    ]
    assert 'run_context' in inspect.signature(GalaxieModel.request_stream).parameters
    assert not hasattr(pydantic_ai, 'get_current_run_context')
    executor, transport, result = execute('flatten')
    assert result is None
    assert asyncio.run(executor.run(None, 'conversation', 20,
                                   resume=answer(executor, ['flat-gate']))) == 'parent-done'
    assert len(transport.models) == 2
    # A fresh top-level run of the same executor must acquire a new run ID.
    assert asyncio.run(executor.run({'prompt': 'parent'}, 'second-conversation', 20)) is None
    assert len(transport.models) == 3
    _, retry_transport, retry_result = execute('top-retry')
    assert retry_result == {'value': 7}
    assert len(retry_transport.models) == 2
    _, parallel_transport, parallel_result = execute('top-parallel')
    assert parallel_result == 'parent-done'
    assert len(parallel_transport.models) == 2
    assert sorted(item['input']['value'] for item in parallel_transport.capabilities) == [1, 2]


@pytest.mark.parametrize('name', ['guard', 'guard-stream'])
def test_g2_public_guard_refuses_child_before_its_first_bridge_request(name):
    # P0 guard outcome: the parent request is visible; no child request follows it.
    transport = Transport(name)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(factory(name).run({'prompt': 'parent'}, 'conversation', 20))
    assert error.value.code == 'unsupported'
    assert [item['role'] for item in transport.models] == ['answer']
    assert transport.capabilities == []


def test_g1_nested_after_parent_resume_is_refused_without_false_positive():
    # The child can run before the parent's first model request of the resumed
    # segment; the executor registers its run before deferred tools re-execute.
    executor, transport, result = execute('guard-resume')
    assert result is None
    assert len(transport.models) == 1
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run(None, 'conversation', 20,
                                resume=answer(executor, ['delegate'])))
    assert error.value.code == 'unsupported'
    assert len(transport.models) == 1
    assert transport.capabilities == []


def test_g1_parallel_nested_runs_are_refused():
    transport = Transport('parallel-pause')
    with pytest.raises(GalaxieError) as error:
        asyncio.run(factory('parallel-pause', 'plain').run({'prompt': 'parent'}, 'conversation', 20))
    assert error.value.code == 'unsupported'
    assert len(transport.models) == 1
    assert transport.capabilities == []


def test_g1_nested_approved_capability_is_refused_before_bridge_on_resume():
    # A child's approved capability runs before its next model request, so a model
    # guard alone is insufficient. Public tool RunContext supplies the same signal.
    executor, transport, result = execute('hoist', 'helper')
    assert result is None
    restored = factory('hoist', 'plain')
    restored._restore(*executor._snapshot('conversation'))
    with pytest.raises(GalaxieError) as error:
        asyncio.run(restored.run(None, 'conversation', 20, resume=answer(restored, ['delegate'])))
    assert error.value.code == 'unsupported'
    assert len(transport.models) == 3
    assert [item['input']['value'] for item in transport.capabilities] == [2]
