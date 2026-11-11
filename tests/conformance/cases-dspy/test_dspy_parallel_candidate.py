# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Branch journal criteria, exercised through the real durable driver."""

import asyncio
from collections import Counter
import copy
import json
from typing import Any

import galaxie.dspy as face
from galaxie._bridge import GalaxieError, MAX_BYTES
import pytest

import parallel_candidate as candidate
from test_dspy_parallel_baseline import FIXTURES, LABELS, Store, complete, native, native_reference, payloads


@pytest.fixture
def installed():
    originals = (face._Run.begin, face._Run.capability, face._Run.replaying, face.request, face.Executor._restore)
    uninstall = candidate.install()
    try:
        yield
    finally:
        uninstall()
    assert originals == (face._Run.begin, face._Run.capability, face._Run.replaying, face.request, face.Executor._restore)


@pytest.mark.parametrize('order', FIXTURES['orders'])
@pytest.mark.parametrize('name,shape', [('par-fan-single', 'single'), ('par-fan-write', 'write'), ('par-fan-multi', 'multi'), ('par-fan-eval-loop', 'single')])
def test_branch_results_and_full_requests_equal_native(installed, name, shape, order):
    store = Store(order)
    result = complete(store, name, candidate=True)
    expected, requests = native_reference(shape, evaluate=name == 'par-fan-eval-loop')
    assert result == {'ok': True, 'output': expected}
    assert payloads(store.model_payloads) == payloads(requests)
    assert store.orphans == 0 and store.after_termination == 0


@pytest.mark.parametrize('order', FIXTURES['orders'])
@pytest.mark.parametrize('shape', ['single', 'multi'])
def test_branch_journal_restores_in_a_fresh_driver(installed, shape, order):
    store = Store(order)
    name = 'par-fan-two-stage-' + shape
    context = store.boot(name, candidate=True)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    requests, calls = store.requests, len(store.calls)
    journal = store.journal_at_return
    assert all(len(entry['branch']) <= 70 for entry in journal if 'branch' in entry)
    store.order = 'reversed' if order == 'forward' else 'forward'
    context = store.boot(name, candidate=True)
    assert native.pending(context) == before
    first, _ = native_reference(shape)
    second, _ = native_reference(shape, stage='after')
    assert store.execute(context, before) == {'ok': True, 'output': {'before': first['answers'], 'answers': second['answers']}}
    assert store.requests - requests == (6 if shape == 'multi' else 3)
    assert store.model_labels[requests:] == [label for label in store.model_labels[requests:] if ':after' in label or ':last-after' in label]
    assert len(store.calls) - calls == (3 if shape == 'multi' else 0)
    assert sum(event.get('kind') == 'replayed' for event in store.events) == 1


@pytest.mark.parametrize('name', ['par-fan-write', 'par-fan-multi'])
def test_reversed_redispatch_reuses_each_branch_receipt(installed, name):
    store = Store('forward')
    context = store.boot(name, candidate=True)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    store.crash_after_writes = 2
    context = store.boot(name, candidate=True)
    assert native.pending(context) == before
    assert store.execute(context, before) == {'ok': False, 'code': 'cancelled'}
    assert len(store.calls) == 2
    store.crash_after_writes = None
    store.order = 'reversed'
    context = store.boot(name, candidate=True)
    assert native.pending(context) == before
    expected, _ = native_reference('write' if name.endswith('write') else 'multi')
    assert store.execute(context, before) == {'ok': True, 'output': expected}
    assert Counter(store.calls) == Counter(f'{label}:before' for label in LABELS)
    assert len(store.effects) == 3 and store.orphans == 0


@pytest.mark.parametrize('changed', [True, 'removed'])
def test_divergence_releases_barrier_without_dispatch(installed, changed):
    store = Store()
    name = 'par-fan-diverge'
    context = store.boot(name, candidate=True)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    requests, calls = store.requests, len(store.calls)
    context = store.boot(name, candidate=True, changed=changed)
    assert native.pending(context) == before
    assert store.execute(context, before) == {'ok': False, 'code': 'unrecoverable'}
    assert (store.requests - requests, len(store.calls) - calls, store.orphans, store.after_termination) == (0, 0, 0, 0)


@pytest.mark.parametrize('name', ['par-fan-pause-in-branch', 'par-fan-concurrent-pauses'])
def test_branch_pause_refusal_drains_siblings(installed, name):
    store = Store()
    assert complete(store, name, candidate=True) == {'ok': False, 'code': 'unsupported'}
    assert store.orphans == 0 and store.after_termination == 0


def test_non_fan_out_bytes_and_legacy_restore_are_unchanged():
    store = native.Store()
    context = store.boot('durable-module')
    assert native.execute(context) == {'ok': True, 'interrupted': True}
    executor = context['_galaxie_executor']
    conversation = context['_galaxie_conversations']['session']
    checkpoint, metadata = executor._snapshot(conversation, 'session')
    unpatched = native.Store().boot('durable-module')['_galaxie_executor']
    assert asyncio.run(unpatched.run({'question': native.durable.PRIVATE_INPUT}, 'identical', 50)) is None
    expected = unpatched._snapshot('identical', 'session')
    uninstall = candidate.install()
    try:
        patched = native.Store().boot('durable-module')['_galaxie_executor']
        assert asyncio.run(patched.run({'question': native.durable.PRIVATE_INPUT}, 'identical', 50)) is None
        assert patched._snapshot('identical', 'session') == expected
        assert executor._snapshot(conversation, 'session') == (checkpoint, metadata)
        restored = store.boot('durable-module')
        identifier = restored['_galaxie_executor']._restore(checkpoint, metadata, 'session')
        assert restored['_galaxie_executor']._snapshot(identifier, 'session') == (checkpoint, metadata)
        assert native.execute(restored, native.pending(restored))['ok']
    finally:
        uninstall()


def test_old_reader_refuses_branch_records_without_changing_stored_rows():
    store = Store()
    uninstall = candidate.install()
    try:
        context = store.boot('par-fan-two-stage-single', candidate=True)
        assert store.execute(context) == {'ok': True, 'interrupted': True}
    finally:
        uninstall()
    rows = copy.deepcopy(store.rows)
    context = store.boot('par-fan-two-stage-single')
    context['_galaxie_thread'] = 'session'
    assert json.loads(asyncio.run(context['_galaxie_pending']())) == {'ok': False, 'code': 'unrecoverable'}
    assert store.rows == rows


@pytest.mark.parametrize('mark', ['', 'a/01', 'a/x', 'a/100000', 'a' * 65 + '/0', 1])
def test_restore_refuses_malformed_branch_markers(installed, mark):
    store = Store()
    context = store.boot('par-fan-two-stage-single', candidate=True)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    executor = context['_galaxie_executor']
    identifier = context['_galaxie_conversations']['session']
    checkpoint, metadata = executor._snapshot(identifier, 'session')
    raw = json.loads(checkpoint)
    raw['journal'][0]['branch'] = mark
    with pytest.raises(GalaxieError) as caught:
        executor._restore(json.dumps(raw).encode(), metadata, 'session')
    assert caught.value.code == 'unrecoverable'


@pytest.mark.parametrize('shape', ['empty', 'one', 'invalid', 'duplicate', 'wide', 'nested', 'streaming'])
def test_group_bounds_and_fixed_refusals(installed, shape):
    async def run():
        session = face._Session()
        active = face._Run('bounded', 1, session, streaming=shape == 'streaming')
        token = face._run.set(active)
        async def value():
            return 'done'
        async def nested():
            return await candidate.branches({'inner': value})
        class Duplicate:
            def items(self):
                return [('same', value), ('same', value)]
        items: Any = {} if shape == 'empty' else {'one': value}
        if shape == 'invalid':
            items = {'invalid/key': value}
        elif shape == 'duplicate':
            items = Duplicate()
        elif shape == 'wide':
            items = {str(index): value for index in range(33)}
        elif shape == 'nested':
            items = {'outer': nested}
        try:
            if shape in {'one', 'empty'}:
                assert await candidate.branches(items) == ({} if shape == 'empty' else {'one': 'done'})
            else:
                with pytest.raises(BaseException) as caught:
                    await candidate.branches(items)
                assert face.error_code(caught.value) == 'unsupported'
                assert active.failure == 'unsupported'
        finally:
            face._run.reset(token)
    asyncio.run(run())


def test_entry_marker_size_and_existing_pause_bound(installed):
    async def run():
        session = face._Session()
        active = face._Run('bounded', 1, session)
        token = face._run.set(active)
        async def value():
            entry, _ = active.begin('capability', {'name': 'docs.lookup@1', 'input': {}})
            entry['result'] = 'done'
        try:
            await candidate.branches({'a' * 64: value})
            entry = session.journal[0]
            assert set(entry) == {'kind', 'digest', 'branch', 'result'}
            assert len(entry['branch']) == 66
            session.value = 'x' * MAX_BYTES
            with pytest.raises(face._Termination) as caught:
                session.bounded()
            assert caught.value.code == 'unsupported'
        finally:
            face._run.reset(token)
    asyncio.run(run())
