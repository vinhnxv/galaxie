# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Durable shipped-helper evidence, including real thread hops and old readers."""

import asyncio
import base64
from collections import Counter
import copy
from contextlib import nullcontext
import json
from pathlib import Path
import subprocess
import sys
import tarfile
from unittest.mock import patch
import uuid

import pytest

from galaxie import GalaxieError, capabilities
import galaxie.dspy as face
import shipped_branches
from test_dspy_parallel_baseline import LABELS, Store, complete, inline_thread_hops, native, native_reference, payloads


@pytest.fixture(autouse=True)
def shipped(monkeypatch):
    monkeypatch.setitem(sys.modules, 'parallel_candidate', shipped_branches)
    monkeypatch.setattr(uuid, 'uuid4', lambda: uuid.UUID('55de87eb-28d7-466f-9222-de0713ae5d68'))


@pytest.mark.parametrize('shape', ['single', 'write', 'multi'])
@pytest.mark.parametrize('inline', [False, True])
def test_arrival_and_thread_hops_do_not_change_scopes_receipts_or_checkpoint_bytes(shape, inline):
    records = []
    for order in ['forward', 'reversed']:
        store = Store(order)
        # These scenarios pause after joining, retaining the complete journal.
        name = 'par-fan-diverge' if shape == 'single' else 'par-fan-two-stage-' + shape
        if shape == 'write':
            # Reuse the multi-stage scenario with a write-only branch body.
            name = 'par-fan-diverge'
        original = shipped_branches.branches
        async def writes(group):
            async def write(key):
                return await capabilities.call('docs.lookup@1', {'query': key.split('.')[-1] + ':before'})
            return await original({key: lambda key=key: write(key) for key in group})
        with (inline_thread_hops() if inline else nullcontext()), patch.object(shipped_branches, 'branches', writes if shape == 'write' else original):
            context = store.boot(name, candidate=True)
            assert store.execute(context) == {'ok': True, 'interrupted': True}
        assert store.orphans == store.after_termination == 0
        records.append((store.rows, store.writes, store.effects))
        assert all('fanout' in entry and 'result' in entry for entry in store.journal_at_return[:-1])
    assert records[0] == records[1]


@pytest.mark.parametrize('order', ['forward', 'reversed'])
@pytest.mark.parametrize('shape', ['single', 'multi'])
def test_fresh_driver_replays_join_without_any_before_requests(shape, order):
    store = Store(order)
    name = 'par-fan-two-stage-' + shape
    context = store.boot(name, candidate=True)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    requests, calls = store.requests, len(store.calls)
    store.order = 'reversed' if order == 'forward' else 'forward'
    context = store.boot(name, candidate=True)
    assert native.pending(context) == before
    first, _ = native_reference(shape)
    second, _ = native_reference(shape, stage='after')
    assert store.execute(context, before) == {'ok': True, 'output': {'before': first['answers'], 'answers': second['answers']}}
    assert all(':after' in label or ':last-after' in label for label in store.model_labels[requests:])
    assert all(query.endswith(':after') for query in store.calls[calls:])
    assert store.requests - requests == (6 if shape == 'multi' else 3)
    assert sum(event.get('kind') == 'replayed' for event in store.events) == 1
    assert store.orphans == store.after_termination == 0


def test_silent_replay_makes_zero_requests():
    store = Store('reversed')
    store.question = 'reload'
    name = 'par-fan-eval-loop'
    context = store.boot(name, candidate=True)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    expected, _ = native_reference(evaluate=True)
    assert store.execute(store.boot(name, candidate=True), before) == {'ok': True, 'output': expected}
    assert store.requests == 4 and not store.calls
    assert sum(event.get('kind') == 'replayed' for event in store.events) == 1


@pytest.mark.parametrize('name', ['par-fan-write', 'par-fan-multi'])
def test_crash_after_two_writes_reuses_receipts_on_reversed_restart(name):
    store = Store()
    context = store.boot(name, candidate=True)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    store.crash_after_writes = 2
    assert store.execute(store.boot(name, candidate=True), before) == {'ok': False, 'code': 'cancelled'}
    assert len(store.calls) == 2
    store.crash_after_writes = None
    store.order = 'reversed'
    expected, _ = native_reference('write' if name.endswith('write') else 'multi')
    assert store.execute(store.boot(name, candidate=True), before) == {'ok': True, 'output': expected}
    assert Counter(store.calls) == Counter(f'{label}:before' for label in LABELS)
    assert len(store.effects) == 3 and store.orphans == store.after_termination == 0


@pytest.mark.parametrize('changed', ['request', 'removed', 'renamed', 'extra', 'extra-key', 'fewer'])
@pytest.mark.parametrize('order', ['forward', 'reversed'])
def test_divergence_appends_one_poison_row_and_later_restore_adds_nothing(monkeypatch, changed, order):
    store = Store(order)
    name = 'par-fan-diverge'
    context = store.boot(name, candidate=True)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    rows, writes = copy.deepcopy(store.rows), copy.deepcopy(store.writes)
    counts = store.requests, list(store.calls)
    original = shipped_branches.branches
    async def divergent(group):
        group = dict(group)
        if changed == 'removed':
            group.pop('before.gamma')
        elif changed == 'renamed':
            group['renamed'] = group.pop('before.alpha')
        elif changed in {'extra', 'extra-key'}:
            async def extra():
                return await capabilities.call('docs.lookup@1', {'query': 'alpha:added'})
            if changed == 'extra':
                call = group['before.alpha']
                async def extra_call():
                    await call()
                    return await capabilities.call('docs.lookup@1', {'query': 'alpha:added'})
                group['before.alpha'] = extra_call
            else:
                group = {'added': extra, **group} if order == 'forward' else {**group, 'added': extra}
        elif changed == 'fewer':
            group['before.alpha'] = lambda: asyncio.sleep(0, result='silent')
        return await original(group)
    monkeypatch.setattr(shipped_branches, 'branches', divergent)
    context = store.boot(name, candidate=True, changed=changed == 'request')
    assert native.pending(context) == before
    assert store.execute(context, before) == {'ok': False, 'code': 'unrecoverable'}
    assert (store.requests, store.calls) == counts
    assert {key: store.rows[key] for key in rows} == rows
    assert {key: store.writes[key] for key in writes} == writes
    added = set(store.rows) - set(rows)
    assert len(added) == 1
    identifier = added.pop()
    assert identifier == f'{int(max(rows)) + 1:020d}'
    marker = store.rows[identifier]
    assert marker['parentId'] == max(rows)
    checkpoint = json.loads(base64.b64decode(marker['checkpoint']['bytes']))
    assert checkpoint['status'] == 'unrecoverable' and checkpoint['input'] is None and checkpoint['journal'] == []
    assert set(json.loads(base64.b64decode(marker['metadata']['bytes']))) == {'v', 'dspy', 'adapter', 'session'}
    assert len(store.writes[identifier]) == 1
    write = store.writes[identifier][0]
    assert (write['channel'], write['index'], write['value']['type']) == ('__interrupt__', -3, 'json')
    assert json.loads(base64.b64decode(write['value']['bytes'])) is None
    poisoned_rows, poisoned_writes = copy.deepcopy(store.rows), copy.deepcopy(store.writes)
    monkeypatch.setattr(shipped_branches, 'branches', original)
    restored = store.boot(name, candidate=True)
    restored['_galaxie_thread'] = 'session'
    assert json.loads(asyncio.run(restored['_galaxie_pending']())) == {'ok': False, 'code': 'unrecoverable'}
    assert store.rows == poisoned_rows and store.writes == poisoned_writes
    assert (store.requests, store.calls) == counts
    assert store.orphans == store.after_termination == 0


def test_legacy_records_restore_and_new_root_records_are_byte_identical():
    records = json.loads(Path(__file__).with_name('branch-legacy-record.json').read_text())
    store = native.Store()
    context = store.boot('durable-module')
    assert native.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    current = {'paused': store.rows[max(store.rows)]}
    assert native.execute(context, before)['ok']
    current['completed'] = store.rows[max(store.rows)]
    for status, frozen in records.items():
        assert {key: current[status][key]['bytes'] for key in frozen} == frozen
        executor = store.boot('durable-module')['_galaxie_executor']
        checkpoint, metadata = (base64.b64decode(frozen[key]) for key in ('checkpoint', 'metadata'))
        identifier = executor._restore(checkpoint, metadata, 'session')
        assert executor._snapshot(identifier, 'session') == (checkpoint, metadata)


def test_malformed_marker_fails_before_registration_without_writing():
    store = Store()
    context = store.boot('par-fan-diverge', candidate=True)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    row = store.rows[max(store.rows)]
    checkpoint = json.loads(base64.b64decode(row['checkpoint']['bytes']))
    checkpoint['journal'][0]['fanout'] = '00/alpha/0'
    row['checkpoint']['bytes'] = base64.b64encode(json.dumps(checkpoint).encode()).decode()
    rows, writes = copy.deepcopy(store.rows), copy.deepcopy(store.writes)
    restored = store.boot('par-fan-diverge', candidate=True)
    restored['_galaxie_thread'] = 'session'
    assert json.loads(asyncio.run(restored['_galaxie_pending']())) == {'ok': False, 'code': 'unrecoverable'}
    assert not restored['_galaxie_executor']._sessions
    assert store.rows == rows and store.writes == writes


def test_real_old_reader_refuses_new_records_without_any_write(tmp_path):
    if subprocess.run(['git', 'cat-file', '-e', 'a403bd9^{commit}'], capture_output=True).returncode:
        pytest.skip('The pinned pre-helper commit is absent from local history.')
    archive = tmp_path / 'old.tar'
    with archive.open('wb') as output:
        subprocess.run(['git', 'archive', 'a403bd9', 'python/galaxie/src/galaxie'], stdout=output, check=True, cwd=Path(__file__).parents[3])
    with tarfile.open(archive) as source:
        source.extractall(tmp_path, filter='data')
    store = Store()
    context = store.boot('par-fan-diverge', candidate=True)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    rows, writes = copy.deepcopy(store.rows), copy.deepcopy(store.writes)
    row = store.rows[max(store.rows)]
    script = f'''import sys, base64, pathlib
sys.path.insert(0, {str(tmp_path / 'python/galaxie/src')!r})
import galaxie
assert pathlib.Path(galaxie.__file__).is_relative_to({str(tmp_path)!r})
from galaxie.dspy import Executor
import dspy
class Program(dspy.Module):
    async def aforward(self):
        return dspy.Prediction()
executor = Executor(Program())
try:
    executor._restore(base64.b64decode({row['checkpoint']['bytes']!r}), base64.b64decode({row['metadata']['bytes']!r}), 'session')
except galaxie.GalaxieError as error:
    assert not executor._sessions
    print(error.code)
'''
    result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, check=True, timeout=900)
    assert result.stdout.strip() == 'unrecoverable'
    assert store.rows == rows and store.writes == writes


@pytest.mark.parametrize('name', ['par-fan-pause-in-branch', 'par-fan-concurrent-pauses'])
def test_pause_refusal_drains_every_branch(name):
    store = Store()
    assert complete(store, name, candidate=True) == {'ok': False, 'code': 'unsupported'}
    assert store.orphans == store.after_termination == 0


def test_an_added_silent_branch_is_not_divergence(monkeypatch):
    store = Store()
    name = 'par-fan-diverge'
    context = store.boot(name, candidate=True)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    rows, writes = copy.deepcopy(store.rows), copy.deepcopy(store.writes)
    original = shipped_branches.branches
    async def with_silent(group):
        results = await original({**group, 'added': lambda: asyncio.sleep(0, result='silent')})
        return {key: results[key] for key in group}
    monkeypatch.setattr(shipped_branches, 'branches', with_silent)
    expected, _ = native_reference()
    after, _ = native_reference(stage='after')
    assert store.execute(store.boot(name, candidate=True), before) == {'ok': True, 'output': {'before': expected['answers'], 'answers': after['answers']}}
    assert store.requests == 6 and not store.calls
    assert {key: store.rows[key] for key in rows} == rows
    assert {key: store.writes[key] for key in writes} == writes
    assert all(json.loads(base64.b64decode(row['checkpoint']['bytes']))['status'] != 'unrecoverable' for row in store.rows.values())
