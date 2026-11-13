# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Characterize direct driver repeats and pin the first poison commit."""

import asyncio
import base64
import copy
import json

import pytest

from binding_poison_programs import create_agent
from test_dspy_durable import Store, durable, execute, pending


@pytest.fixture(autouse=True)
def selected_program(monkeypatch):
    monkeypatch.setattr(durable, 'factory', lambda name, changed=False: create_agent(changed if isinstance(changed, str) else 'original'))


def decoded(value):
    return json.loads(base64.b64decode(value['bytes']))


def assert_marker(store, rows, writes):
    assert {key: store.rows[key] for key in rows} == rows
    assert {key: store.writes[key] for key in writes} == writes
    added = set(store.rows) - set(rows)
    assert len(added) == 1
    identifier = added.pop()
    marker = store.rows[identifier]
    assert identifier == f'{int(max(rows)) + 1:020d}'
    assert marker['parentId'] == max(rows)
    checkpoint = decoded(marker['checkpoint'])
    assert checkpoint['status'] == 'unrecoverable'
    assert checkpoint['input'] is None and checkpoint['journal'] == []
    assert set(decoded(marker['metadata'])) == {'v', 'dspy', 'adapter', 'session'}
    assert decoded(marker['metadata'])['v'] == 1
    assert len(store.writes[identifier]) == 1
    write = store.writes[identifier][0]
    assert (write['channel'], write['index'], write['value']['type']) == ('__interrupt__', -3, 'json')
    assert decoded(write['value']) is None


def assert_poison_pending(store, context):
    saved = copy.deepcopy((store.rows, store.writes, store.effects, store.calls, store.requests))
    context['_galaxie_thread'] = 'session'
    assert json.loads(asyncio.run(context['_galaxie_pending']())) == {'ok': False, 'code': 'unrecoverable'}
    assert (store.rows, store.writes, store.effects, store.calls, store.requests) == saved


@pytest.mark.parametrize('variant', ['changed', 'removed'])
@pytest.mark.parametrize('fresh', [False, True], ids=['same-driver', 'fresh-driver'])
def test_direct_execute_repeats_are_characterization_not_a_public_bound(variant, fresh):
    store = Store()
    original = store.boot('poison-bound')
    assert execute(original) == {'ok': True, 'interrupted': True}
    before = pending(original)
    assert before is not None
    rows, writes = copy.deepcopy(store.rows), copy.deepcopy(store.writes)
    context = store.boot('poison-bound', changed=variant)
    assert pending(context) == before
    assert execute(context, before) == {'ok': False, 'code': 'unrecoverable'}
    assert_marker(store, rows, writes)
    traffic = copy.deepcopy((store.calls, store.requests, store.effects))
    for answer in (before, None, before):
        if fresh:
            context = store.boot('poison-bound', changed=variant)
        assert execute(context, answer) == {'ok': False, 'code': 'unrecoverable'}
        assert (store.calls, store.requests, store.effects) == traffic
    print(json.dumps({'lane': 'native-fresh-driver' if fresh else 'native-same-driver', 'variant': variant, 'markersAfterRepeats': len(store.rows) - len(rows)}))
    assert_poison_pending(store, store.boot('poison-bound'))


@pytest.mark.parametrize('variant', ['changed', 'removed'])
@pytest.mark.parametrize('fresh', [False, True], ids=['same-driver', 'fresh-driver'])
def test_failed_first_marker_commit_is_retried_before_pending_refuses(variant, fresh):
    store = Store()
    context = store.boot('poison-bound')
    assert execute(context) == {'ok': True, 'interrupted': True}
    before = pending(context)
    assert before is not None
    rows, writes = copy.deepcopy(store.rows), copy.deepcopy(store.writes)
    traffic = copy.deepcopy((store.calls, store.requests, store.effects))
    store.fail_completion = True
    context = store.boot('poison-bound', changed=variant)
    assert execute(context, before) == {'ok': False, 'code': 'unrecoverable'}
    assert store.failed and store.rows == rows
    assert {key: store.writes[key] for key in writes} == writes
    assert (store.calls, store.requests, store.effects) == traffic
    if fresh:
        context = store.boot('poison-bound', changed=variant)
    assert execute(context, before) == {'ok': False, 'code': 'unrecoverable'}
    assert_marker(store, rows, writes)
    assert (store.calls, store.requests, store.effects) == traffic
    # Public recovery reads pending before execute; a committed poison cannot advance it.
    assert_poison_pending(store, context)
    assert_poison_pending(store, store.boot('poison-bound'))


def test_unchanged_program_completes_without_poison():
    store = Store()
    context = store.boot('poison-control')
    assert execute(context) == {'ok': True, 'interrupted': True}
    before = pending(context)
    context = store.boot('poison-control')
    assert pending(context) == before
    assert execute(context, before) == {'ok': True, 'output': {'answer': 'done'}}
    assert store.calls == ['before', 'after'] and store.requests == 1
    assert pending(store.boot('poison-control')) is None
    assert all(decoded(row['checkpoint'])['status'] != 'unrecoverable' for row in store.rows.values())
