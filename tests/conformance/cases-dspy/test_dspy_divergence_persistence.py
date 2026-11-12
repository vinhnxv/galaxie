# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Pin compact poison checkpoints for sequential runtime replay divergence."""

import asyncio
import base64
import copy
import json

import dspy
from galaxie import capabilities
from galaxie.dspy import Executor, GalaxieLM, request_interaction
import pytest

from test_dspy_durable import Store, durable, execute, pending


def factory(name, changed=False):
    class Program(dspy.Module):
        def __init__(self):
            self.predict = dspy.Predict('question: str -> answer: str')
            self.predict.set_lm(GalaxieLM('answer'))

        async def aforward(self, question):
            if changed != 'removed':
                await capabilities.call('docs.lookup@1', {'query': 'changed' if changed else 'before'})
            request_interaction({'surfaceId': 'main', 'viewRevision': 'first', 'component': 'test.Review/v1', 'props': {}})
            await capabilities.call('docs.lookup@1', {'query': 'after'})
            return await self.predict.acall(question=question)

    return Executor(Program())


@pytest.mark.parametrize('changed', ['changed', 'removed'])
def test_sequential_divergence_appends_one_compact_poison_checkpoint_and_is_never_retried(monkeypatch, changed):
    monkeypatch.setattr(durable, 'factory', factory)
    store = Store()
    context = store.boot('sequential-divergence')
    assert execute(context) == {'ok': True, 'interrupted': True}
    before = pending(context)
    assert before is not None
    rows, writes = copy.deepcopy(store.rows), copy.deepcopy(store.writes)
    calls, requests = list(store.calls), store.requests
    context = store.boot('sequential-divergence', changed=changed)
    assert pending(context) == before
    assert execute(context, before) == {'ok': False, 'code': 'unrecoverable'}
    assert store.calls == calls and store.requests == requests
    assert {key: store.rows[key] for key in rows} == rows
    assert {key: store.writes[key] for key in writes} == writes
    added = set(store.rows) - set(rows)
    assert len(added) == 1
    identifier = added.pop()
    marker = store.rows[identifier]
    assert identifier == f'{int(max(rows)) + 1:020d}'
    assert marker['parentId'] == max(rows)
    checkpoint = json.loads(base64.b64decode(marker['checkpoint']['bytes']))
    assert checkpoint['status'] == 'unrecoverable'
    assert checkpoint['input'] is None and checkpoint['journal'] == []
    assert set(json.loads(base64.b64decode(marker['metadata']['bytes']))) == {'v', 'dspy', 'adapter', 'session'}
    assert len(store.writes[identifier]) == 1
    write = store.writes[identifier][0]
    assert (write['channel'], write['index'], write['value']['type']) == ('__interrupt__', -3, 'json')
    assert json.loads(base64.b64decode(write['value']['bytes'])) is None

    poisoned_rows, poisoned_writes = copy.deepcopy(store.rows), copy.deepcopy(store.writes)
    restored = store.boot('sequential-divergence')
    restored['_galaxie_thread'] = 'session'
    assert json.loads(asyncio.run(restored['_galaxie_pending']())) == {'ok': False, 'code': 'unrecoverable'}
    assert store.calls == calls and store.requests == requests
    assert store.rows == poisoned_rows and store.writes == poisoned_writes

    # Repeated execute currently appends another marker; its count is not a contract.
    assert execute(context, before) == {'ok': False, 'code': 'unrecoverable'}
    assert store.calls == calls and store.requests == requests
    print(json.dumps({'variant': changed, 'markersAfterSecondExecute': len(store.rows) - len(rows)}))


def test_unchanged_sequential_program_resumes_without_a_poison_checkpoint(monkeypatch):
    monkeypatch.setattr(durable, 'factory', factory)
    store = Store()
    context = store.boot('sequential-control')
    assert execute(context) == {'ok': True, 'interrupted': True}
    before = pending(context)
    assert before is not None
    context = store.boot('sequential-control')
    assert pending(context) == before
    assert execute(context, before) == {'ok': True, 'output': {'answer': 'done'}}
    assert store.calls == ['before', 'after'] and store.requests == 1
    assert pending(store.boot('sequential-control')) is None
    assert all(json.loads(base64.b64decode(row['checkpoint']['bytes']))['status'] != 'unrecoverable' for row in store.rows.values())
