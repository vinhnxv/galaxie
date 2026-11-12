# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Pin compact poison checkpoints and persistent refusal after branch divergence."""

import asyncio
import base64
import copy
import json

import pytest

import parallel_candidate as candidate
from test_dspy_parallel_baseline import Store, native


@pytest.mark.parametrize('changed', [True, 'removed'])
def test_branch_divergence_appends_one_compact_poison_checkpoint_and_is_never_retried(changed):
    uninstall = candidate.install()
    try:
        store = Store()
        context = store.boot('par-fan-diverge', candidate=True)
        assert store.execute(context) == {'ok': True, 'interrupted': True}
        pending = native.pending(context)
        rows, writes = copy.deepcopy(store.rows), copy.deepcopy(store.writes)
        counts = store.requests, len(store.calls)
        context = store.boot('par-fan-diverge', candidate=True, changed=changed)
        assert native.pending(context) == pending
        assert store.execute(context, pending) == {'ok': False, 'code': 'unrecoverable'}
        assert (store.requests, len(store.calls)) == counts
        assert {key: store.rows[key] for key in rows} == rows
        assert {key: store.writes[key] for key in writes} == writes
        added = set(store.rows) - set(rows)
        assert len(added) == 1
        identifier = added.pop()
        marker = store.rows[identifier]
        assert identifier == f'{int(max(rows)) + 1:020d}'
        checkpoint = json.loads(base64.b64decode(marker['checkpoint']['bytes']))
        assert checkpoint['status'] == 'unrecoverable'
        assert checkpoint['input'] is None and checkpoint['journal'] == []
        assert marker['parentId'] == max(rows)
        assert set(json.loads(base64.b64decode(marker['metadata']['bytes']))) == {'v', 'dspy', 'adapter', 'session'}
        assert len(store.writes[identifier]) == 1
        write = store.writes[identifier][0]
        assert (write['channel'], write['index'], write['value']['type']) == ('__interrupt__', -3, 'json')
        assert json.loads(base64.b64decode(write['value']['bytes'])) is None
        poisoned_rows, poisoned_writes = copy.deepcopy(store.rows), copy.deepcopy(store.writes)
        context = store.boot('par-fan-diverge', candidate=True)
        context['_galaxie_thread'] = 'session'
        assert json.loads(asyncio.run(context['_galaxie_pending']())) == {'ok': False, 'code': 'unrecoverable'}
        assert (store.requests, len(store.calls)) == counts
        assert store.rows == poisoned_rows and store.writes == poisoned_writes
        assert store.orphans == store.after_termination == 0
    finally:
        uninstall()
