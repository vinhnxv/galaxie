# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Measure a test-only binding through the unchanged native durable driver."""

import asyncio
import base64
from contextlib import nullcontext
import copy
import json
from pathlib import Path

from dspy.primitives.base_module import BaseModule
import pytest

from test_dspy_state_durable import Store, checkpoint, load_module, native, programs, state_file

candidate = load_module('state_bind_candidate', 'state_bind_candidate.py')
FIXTURES = json.loads(Path(__file__).with_name('state-bind-fixtures.json').read_text())


def root_for(tmp_path, lifetime, swap):
    root = tmp_path / lifetime
    root.mkdir()
    state_file(root, swap).rename(root / 'state.json')
    return root


def patch(root, mode):
    return candidate.installed(root) if mode == 'candidate' else nullcontext()


def replayed(store):
    return [event for event in store.events if event.get('kind') == 'replayed']


@pytest.mark.parametrize('scenario', FIXTURES['scenarios'], ids=lambda scenario: scenario['name'])
def test_state_binding_across_driver_lifetimes(scenario, tmp_path):
    original = root_for(tmp_path, 'pause', 'same')
    replacement = root_for(tmp_path, 'resume', scenario['swap'])
    store = Store()
    with patch(original, scenario['pauseWith']):
        context = store.boot(scenario['program'], original / 'state.json')
        assert native.execute(context) == {'ok': True, 'interrupted': True}
        before = native.pending(context)
    assert before is not None
    saved = copy.deepcopy((store.rows, store.writes, store.effects))
    requests = store.requests
    events = len(store.events)
    with patch(replacement, scenario['resumeWith']):
        context = store.boot(scenario['program'], replacement / 'state.json')
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
        with candidate.installed(original):
            context = store.boot(scenario['program'], original / 'state.json')
            assert native.pending(context) == before
            assert native.execute(context, before)['ok']
            assert checkpoint(store)['status'] == 'completed'
            assert len(replayed(store)) == 1
    assert store.calls == ['before'] and len(store.effects) == 1


def test_bound_metadata_is_bounded_and_old_code_refuses_it(tmp_path):
    root = root_for(tmp_path, 'pause', 'same')
    store = Store()
    with candidate.installed(root):
        context = store.boot('state-durable-late-model', root / 'state.json')
        native.execute(context)
        conversation = context['_galaxie_conversations']['session']
        executor = context['_galaxie_executor']
        bound = executor._snapshot(conversation, 'session')
    plain = executor._snapshot(conversation, 'session')
    assert bound[0] == plain[0]
    meta = json.loads(bound[1])
    assert meta.pop(candidate.BINDING) == candidate.descriptor_digest(root)
    assert meta == json.loads(plain[1])
    assert len(bound[1]) - len(plain[1]) == len(candidate.BINDING) + 6 + 64
    saved = copy.deepcopy((store.rows, store.writes, store.effects))
    context = store.boot('state-durable-late-model', root / 'state.json')
    context['_galaxie_thread'] = 'session'
    assert json.loads(asyncio.run(context['_galaxie_pending']())) == {'ok': False, 'code': 'unrecoverable'}
    assert (store.rows, store.writes, store.effects) == saved


@pytest.mark.parametrize('fault', ['malformed', 'removed'])
def test_malformed_or_missing_binding_refuses_without_writes(fault, tmp_path):
    root = root_for(tmp_path, 'pause', 'same')
    store = Store()
    with candidate.installed(root):
        context = store.boot('state-durable-late-model', root / 'state.json')
        native.execute(context)
        before = native.pending(context)
    if fault == 'malformed':
        row = list(store.rows.values())[-1]
        meta = json.loads(base64.b64decode(row['metadata']['bytes']))
        meta[candidate.BINDING] = 'invalid'
        row['metadata']['bytes'] = base64.b64encode(candidate.encode(meta)).decode()
    else:
        (root / 'state.json').unlink()
    saved = copy.deepcopy((store.rows, store.writes, store.effects))
    with candidate.installed(root):
        # Load the program from existing bytes elsewhere when the descriptor lost its state.
        path = state_file(tmp_path, 'same') if fault == 'removed' else root / 'state.json'
        context = store.boot('state-durable-late-model', path)
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
    with candidate.installed(tmp_path):
        assert executor._snapshot(conversation, 'session') == plain
    before = native.pending(context)
    native.execute(context, before)
    compact = executor._snapshot(conversation, 'session', compact=True)
    (tmp_path / 'state.json').write_text('{}')
    with candidate.installed(tmp_path):
        assert executor._snapshot(conversation, 'session', compact=True) == compact


def test_completed_session_starts_again_under_changed_state(tmp_path):
    original = root_for(tmp_path, 'pause', 'same')
    replacement = root_for(tmp_path, 'resume', 'prompt')
    store = Store()
    with candidate.installed(original):
        context = store.boot('state-durable-late-model', original / 'state.json')
        native.execute(context)
        assert native.execute(context, native.pending(context))['ok']
        assert candidate.BINDING not in json.loads(base64.b64decode(list(store.rows.values())[-1]['metadata']['bytes']))
    with candidate.installed(replacement):
        context = store.boot('state-durable-late-model', replacement / 'state.json')
        assert native.pending(context) is None
        assert native.execute(context) == {'ok': True, 'interrupted': True}
        result = native.execute(context, native.pending(context))
        assert result['ok'] and result['output']['demos'] == 0
    assert store.calls == ['before', 'before'] and len(store.effects) == 2


def test_descriptor_scope_and_module_load_comparison(tmp_path):
    root = root_for(tmp_path, 'pause', 'same')
    source = root / 'selected.py'
    source.write_text('# original\n')
    state, all_files = candidate.descriptor_digest(root), candidate.descriptor_digest(root, 'all')
    source.write_text('# comment-only edit\n')
    assert candidate.descriptor_digest(root) == state
    assert candidate.descriptor_digest(root, 'all') != all_files
    for scope in ('state', 'all'):
        before = candidate.descriptor_digest(root, scope)
        path = root / 'state.json'
        path.write_bytes(path.read_bytes() + b'\n')
        assert candidate.descriptor_digest(root, scope) != before
        before = candidate.descriptor_digest(root, scope)
        path.rename(root / 'renamed.json')
        assert candidate.descriptor_digest(root, scope) != before
        (root / 'renamed.json').rename(path)
        before = candidate.descriptor_digest(root, scope)
        (root / 'extra.json').write_text('{}')
        assert candidate.descriptor_digest(root, scope) != before
        (root / 'extra.json').unlink()
        before = candidate.descriptor_digest(root, scope)
        cache = root / '__pycache__'
        cache.mkdir(exist_ok=True)
        (cache / 'x.json').write_text('ignored')
        assert candidate.descriptor_digest(root, scope) == before
    files = {'b.json': b'{}', 'a.json': b'[]'}
    assert candidate.manifest_digest(files) == candidate.manifest_digest(dict(reversed(list(files.items()))))
    original = BaseModule.load
    with candidate.loaded_files(root) as loaded:
        executor = programs.factory('state-durable-late-model', root / 'state.json')
        assert candidate.manifest_digest(loaded) == candidate.descriptor_digest(root)
    assert BaseModule.load is original
    with candidate.loaded_files(root) as loaded:
        executor.module.predict.load_state(json.loads((root / 'state.json').read_text()))
        assert candidate.manifest_digest(loaded) is None
        assert candidate.descriptor_digest(root) is not None
    assert BaseModule.load is original


def test_fingerprint_recipe_same_bytes_still_completes(tmp_path):
    root = root_for(tmp_path, 'pause', 'same')
    store = Store()
    with candidate.installed(root):
        context = store.boot('state-durable-fingerprint', root / 'state.json')
        native.execute(context)
        assert native.execute(context, native.pending(context))['ok']
