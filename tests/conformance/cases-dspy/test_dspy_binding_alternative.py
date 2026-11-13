# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Pin editable Python data and the unchanged descriptor JSON binding."""

import asyncio
import base64
import copy
import hashlib
import json
from pathlib import Path
import sys

import dspy
import pytest

from binding_poison_programs import create_agent
from test_dspy_durable import DRIVER, Store, durable, execute, pending


def descriptor(tmp_path, lifetime, value='before', json_text='{}', include_json=True):
    root = tmp_path / lifetime
    root.mkdir()
    (root / 'binding_poison_programs.py').write_text(Path(__file__).with_name('binding_poison_programs.py').read_text())
    (root / 'selected.py').write_text('from binding_poison_programs import create_agent\n')
    (root / 'catalog.py').write_text(f'VALUE = {value!r}\n')
    if include_json:
        (root / 'unrelated.json').write_text(json_text)
    return root


def boot(store, root, monkeypatch, variant='data'):
    monkeypatch.syspath_prepend(str(root))
    monkeypatch.delitem(sys.modules, 'catalog', raising=False)
    monkeypatch.setattr(durable, 'factory', lambda name, changed=False: create_agent(variant))
    context = store.boot('binding-alternative')
    context['_galaxie_state_root'] = root
    exec(DRIVER, context)
    assert context['_galaxie_ready'] == {'ok': True}
    return context


def metadata(store):
    return json.loads(base64.b64decode(store.rows[max(store.rows)]['metadata']['bytes']))


def expected_binding(text):
    manifest = [['unrelated.json', hashlib.sha256(text.encode()).hexdigest()]]
    return hashlib.sha256(json.dumps(manifest, separators=(',', ':')).encode()).hexdigest()


def assert_refused_without_changes(store, context):
    saved = copy.deepcopy((store.rows, store.writes, store.effects, store.events, store.calls, store.requests))
    context['_galaxie_thread'] = 'session'
    assert json.loads(asyncio.run(context['_galaxie_pending']())) == {'ok': False, 'code': 'unrecoverable'}
    assert (store.rows, store.writes, store.effects, store.events, store.calls, store.requests) == saved


def test_python_data_edit_resumes_with_new_output_and_one_replay(tmp_path, monkeypatch):
    store = Store()
    original = descriptor(tmp_path, 'original')
    replacement = descriptor(tmp_path, 'replacement', value='updated')
    context = boot(store, original, monkeypatch)
    assert execute(context) == {'ok': True, 'interrupted': True}
    before = pending(context)
    assert before is not None
    assert metadata(store)['stateBinding'] == expected_binding('{}')
    context = boot(store, replacement, monkeypatch)
    assert context['_galaxie_binding'] == expected_binding('{}')
    assert pending(context) == before
    assert execute(context, before) == {'ok': True, 'output': {'answer': 'done', 'catalog': 'updated'}}
    assert store.calls == ['before', 'after'] and store.requests == 1
    assert len([event for event in store.events if event.get('kind') == 'replayed']) == 1
    assert 'stateBinding' not in metadata(store)


def test_unrelated_json_edit_refuses_before_replay_then_rollback_completes(tmp_path, monkeypatch):
    store = Store()
    original = descriptor(tmp_path, 'original')
    replacement = descriptor(tmp_path, 'replacement', json_text='[]')
    context = boot(store, original, monkeypatch)
    assert execute(context) == {'ok': True, 'interrupted': True}
    before = pending(context)
    context = boot(store, replacement, monkeypatch)
    assert context['_galaxie_binding'] == expected_binding('[]')
    assert_refused_without_changes(store, context)
    assert store.calls == ['before'] and store.requests == 0
    assert not [event for event in store.events if event.get('kind') == 'replayed']
    context = boot(store, original, monkeypatch)
    assert pending(context) == before
    assert execute(context, before) == {'ok': True, 'output': {'answer': 'done', 'catalog': 'before'}}
    assert store.calls == ['before', 'after'] and store.requests == 1


def test_python_data_edit_that_changes_a_request_appends_poison(tmp_path, monkeypatch):
    store = Store()
    original = descriptor(tmp_path, 'original')
    replacement = descriptor(tmp_path, 'replacement', value='changed')
    context = boot(store, original, monkeypatch, 'data-request')
    assert execute(context) == {'ok': True, 'interrupted': True}
    before = pending(context)
    rows, writes = copy.deepcopy(store.rows), copy.deepcopy(store.writes)
    context = boot(store, replacement, monkeypatch, 'data-request')
    assert pending(context) == before
    assert execute(context, before) == {'ok': False, 'code': 'unrecoverable'}
    assert {key: store.rows[key] for key in rows} == rows
    assert {key: store.writes[key] for key in writes} == writes
    assert len(store.rows) == len(rows) + 1
    marker = json.loads(base64.b64decode(store.rows[max(store.rows)]['checkpoint']['bytes']))
    assert marker['status'] == 'unrecoverable' and marker['input'] is None and marker['journal'] == []
    assert store.calls == ['before'] and store.requests == 0
    assert_refused_without_changes(store, boot(store, original, monkeypatch, 'data-request'))


def test_python_only_descriptor_preserves_unbound_metadata_bytes(tmp_path, monkeypatch):
    store = Store()
    original = descriptor(tmp_path, 'original', include_json=False)
    context = boot(store, original, monkeypatch)
    assert context['_galaxie_binding'] is None
    assert execute(context) == {'ok': True, 'interrupted': True}
    row = store.rows[max(store.rows)]
    expected = json.dumps({'v': 1, 'dspy': dspy.__version__, 'adapter': 'ChatAdapter', 'session': 'session'}, separators=(',', ':')).encode()
    assert base64.b64decode(row['metadata']['bytes']) == expected
    before = pending(context)
    replacement = descriptor(tmp_path, 'replacement', value='updated', include_json=False)
    context = boot(store, replacement, monkeypatch)
    assert context['_galaxie_binding'] is None and pending(context) == before
    assert execute(context, before) == {'ok': True, 'output': {'answer': 'done', 'catalog': 'updated'}}
    assert base64.b64decode(store.rows[max(store.rows)]['metadata']['bytes']) == expected
