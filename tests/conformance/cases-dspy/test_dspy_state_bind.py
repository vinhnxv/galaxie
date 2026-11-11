# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Measure shipped state binding through the native durable driver."""

import asyncio
import base64
import copy
import json
from pathlib import Path

from galaxie.dspy import prepare_executor, state_binding
import pytest

from test_dspy_state_durable import Store, checkpoint, native, state_file

FIXTURES = json.loads(Path(__file__).with_name('state-bind-fixtures.json').read_text())


def root_for(tmp_path, lifetime, swap):
    root = tmp_path / lifetime
    root.mkdir()
    state_file(root, swap).rename(root / 'state.json')
    return root


def replayed(store):
    return [event for event in store.events if event.get('kind') == 'replayed']


@pytest.mark.parametrize('scenario', FIXTURES['scenarios'], ids=lambda scenario: scenario['name'])
def test_state_binding_across_driver_lifetimes(scenario, tmp_path):
    original = root_for(tmp_path, 'pause', 'same')
    replacement = root_for(tmp_path, 'resume', scenario['swap'])
    store = Store()
    context = store.boot(scenario['program'], original / 'state.json', bind=original if scenario['pause'] == 'bound' else None)
    assert native.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    assert before is not None
    saved = copy.deepcopy((store.rows, store.writes, store.effects))
    requests = store.requests
    events = len(store.events)
    context = store.boot(scenario['program'], replacement / 'state.json', bind=replacement)
    if scenario['predicted'] == 'unrecoverable':
        context['_galaxie_thread'] = 'session'
        assert json.loads(asyncio.run(context['_galaxie_pending']())) == {'ok': False, 'code': 'unrecoverable'}
        assert native.execute(context, before) == {'ok': False, 'code': 'unrecoverable'}
        assert store.requests == requests and store.calls == ['before']
        assert (store.rows, store.writes, store.effects) == saved
        assert len(store.events) == events
        assert context['_galaxie_conversations'] == {}
    else:
        assert native.pending(context) == before
        result = native.execute(context, before)
        state = json.loads((replacement / 'state.json').read_text())
        assert result == {'ok': True, 'output': {'answer': 'done', 'receipt': native.durable.PRIVATE_RESULT, 'demos': len(state['demos']), 'instructions': state['signature']['instructions']}}
        assert store.requests == requests + 1
        assert len(replayed(store)) == 1
        assert checkpoint(store)['status'] == 'completed'
    if scenario.get('then') == 'original':
        context = store.boot(scenario['program'], original / 'state.json', bind=original)
        assert native.pending(context) == before
        assert native.execute(context, before)['ok']
        assert checkpoint(store)['status'] == 'completed'
        assert len(replayed(store)) == 1
    assert store.calls == ['before'] and len(store.effects) == 1


@pytest.mark.parametrize('fault', ['malformed', 'removed'])
def test_malformed_or_missing_binding_refuses_without_writes(fault, tmp_path):
    root = root_for(tmp_path, 'pause', 'same')
    store = Store()
    context = store.boot('state-durable-late-model', root / 'state.json', bind=root)
    native.execute(context)
    before = native.pending(context)
    if fault == 'malformed':
        row = list(store.rows.values())[-1]
        meta = json.loads(base64.b64decode(row['metadata']['bytes']))
        meta['stateBinding'] = 'invalid'
        row['metadata']['bytes'] = base64.b64encode(json.dumps(meta, separators=(',', ':')).encode()).decode()
    else:
        (root / 'state.json').unlink()
    saved = copy.deepcopy((store.rows, store.writes, store.effects))
    # Load the program from existing bytes elsewhere when the descriptor lost its state.
    path = state_file(tmp_path, 'same') if fault == 'removed' else root / 'state.json'
    context = store.boot('state-durable-late-model', path, bind=root)
    assert native.execute(context, before) == {'ok': False, 'code': 'unrecoverable'}
    assert (store.rows, store.writes, store.effects) == saved
    assert store.requests == 0 and store.calls == ['before']


def test_no_state_file_and_compact_metadata_are_unchanged(tmp_path):
    store = native.Store()
    context = store.boot('durable-module')
    native.execute(context)
    executor = context['_galaxie_executor']
    conversation = context['_galaxie_conversations']['session']
    plain = executor._snapshot(conversation, 'session')
    prepare_executor(executor, state_binding=state_binding(tmp_path))
    assert executor._snapshot(conversation, 'session') == plain
    before = native.pending(context)
    native.execute(context, before)
    compact = executor._snapshot(conversation, 'session', compact=True)
    (tmp_path / 'state.json').write_text('{}')
    prepare_executor(executor, state_binding=state_binding(tmp_path))
    assert executor._snapshot(conversation, 'session', compact=True) == compact


def test_completed_session_starts_again_under_changed_state(tmp_path):
    original = root_for(tmp_path, 'pause', 'same')
    replacement = root_for(tmp_path, 'resume', 'prompt')
    store = Store()
    context = store.boot('state-durable-late-model', original / 'state.json', bind=original)
    native.execute(context)
    assert native.execute(context, native.pending(context))['ok']
    assert 'stateBinding' not in json.loads(base64.b64decode(list(store.rows.values())[-1]['metadata']['bytes']))
    context = store.boot('state-durable-late-model', replacement / 'state.json', bind=replacement)
    assert native.pending(context) is None
    assert native.execute(context) == {'ok': True, 'interrupted': True}
    result = native.execute(context, native.pending(context))
    assert result['ok'] and result['output']['demos'] == 0
    assert store.calls == ['before', 'before'] and len(store.effects) == 2


def test_fingerprint_recipe_same_bytes_still_completes(tmp_path):
    root = root_for(tmp_path, 'pause', 'same')
    store = Store()
    context = store.boot('state-durable-fingerprint', root / 'state.json', bind=root)
    native.execute(context)
    assert native.execute(context, native.pending(context))['ok']


def test_legacy_session_that_pauses_again_gains_the_boot_binding(tmp_path):
    store = native.Store()
    context = store.boot('durable-two')
    assert native.execute(context) == {'ok': True, 'interrupted': True}
    first = native.pending(context)
    row = list(store.rows.values())[-1]
    assert 'stateBinding' not in json.loads(base64.b64decode(row['metadata']['bytes']))
    path = tmp_path / 'unrelated.json'
    path.write_text('{}')
    context['_galaxie_state_root'] = tmp_path
    exec(native.DRIVER, context)
    assert native.pending(context) == first
    assert native.execute(context, first) == {'ok': True, 'interrupted': True}
    second = native.pending(context)
    row = list(store.rows.values())[-1]
    assert json.loads(base64.b64decode(row['metadata']['bytes']))['stateBinding'] == state_binding(tmp_path)
    path.write_text('[]')
    saved = copy.deepcopy((store.rows, store.writes, store.effects, store.events, store.requests))
    exec(native.DRIVER, context)
    assert native.execute(context, second) == {'ok': False, 'code': 'unrecoverable'}
    assert (store.rows, store.writes, store.effects, store.events, store.requests) == saved


def test_unreadable_state_only_refuses_a_durable_boot(tmp_path, monkeypatch):
    root = root_for(tmp_path, 'pause', 'same')
    context = Store().boot('state-durable-late-model', root / 'state.json')
    # The author program has no state dependency; only the descriptor scan reads it.
    context['_galaxie_module'] = native.Store().boot('durable-module')['_galaxie_module']
    context['_galaxie_state_root'] = root
    def unreadable(self):
        raise PermissionError('private file path')
    monkeypatch.setattr(Path, 'read_bytes', unreadable)
    exec(native.DRIVER, context)
    assert context['_galaxie_ready'] == {'ok': False, 'code': 'unsupported'}
    context['_galaxie_durable'] = False
    exec(native.DRIVER, context)
    assert context['_galaxie_ready'] == {'ok': True}
    assert context['_galaxie_executor']._state_binding is None
