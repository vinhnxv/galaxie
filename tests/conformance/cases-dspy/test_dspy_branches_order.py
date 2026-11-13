# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Absolute scope and journal-order pins for the unordered golden programs."""

import asyncio
import json
import sys
import uuid

import pytest

from galaxie import _bridge
import shipped_branches
from suite import factory
from test_dspy_parallel_baseline import LABELS, Store, programs


CONVERSATION = '55de87eb-28d7-466f-9222-de0713ae5d68'


@pytest.fixture(autouse=True)
def fixed_identity_and_shipped_helper(monkeypatch):
    monkeypatch.setitem(sys.modules, 'parallel_candidate', shipped_branches)
    monkeypatch.setattr(uuid, 'uuid4', lambda: uuid.UUID(CONVERSATION))


@pytest.mark.parametrize('shape', ['single', 'write', 'multi'])
@pytest.mark.parametrize('order', ['forward', 'reversed'])
def test_unordered_golden_shapes_have_absolute_scopes_and_canonical_journals(shape, order):
    async def scenario():
        scopes, completed, gates = {}, {}, {}
        labels = list(LABELS if order == 'forward' else reversed(LABELS))

        async def transport(raw):
            message = json.loads(raw)
            op, payload = message['op'], message['payload']
            assert op in {'model', 'capability'}
            query = programs.model_question(payload['messages']) if op == 'model' else payload['input']['query']
            label, _, phase = query.partition(':')
            group = op, phase
            waiting = gates.setdefault(group, {})
            waiting[label] = asyncio.Event()
            if len(waiting) == len(LABELS):
                waiting[labels[0]].set()
            await waiting[label].wait()
            completed.setdefault(group, []).append(label)
            position = labels.index(label)
            if position + 1 < len(labels):
                waiting[labels[position + 1]].set()
            if op == 'capability':
                scopes[label] = payload['effectScope']
                result = 'receipt:' + label
            else:
                result = {'content': programs.reply_text(query)}
            return json.dumps({**{key: message[key] for key in ('v', 'id', 'op')}, 'kind': 'response', 'ok': True, 'payload': result})

        _bridge.install_transport(transport)
        executor = factory('fanout-' + shape)
        output = await executor.run({'question': 'fan-out'}, CONVERSATION, 50)
        assert list(output['answers']) == list(LABELS)
        assert completed and all(observed == labels for observed in completed.values())
        assert scopes == ({} if shape == 'single' else {
            key: f'dspy/{CONVERSATION}/1/0/{key}/{0 if shape == "write" else 1}'
            for key in LABELS
        })
        checkpoint, _ = executor._snapshot(CONVERSATION, 'session')
        journal = json.loads(checkpoint)['journal']
        assert [entry['fanout'] for entry in journal] == [
            f'0/{key}/{call}' for key in LABELS
            for call in range(3 if shape == 'multi' else 1)
        ]
        compact, _ = executor._snapshot(CONVERSATION, 'session', compact=True)
        assert json.loads(compact)['journal'] == []

    asyncio.run(scenario())


@pytest.mark.parametrize('order', ['forward', 'reversed'])
def test_paused_multi_call_journal_uses_input_keys_then_local_ordinals(order):
    store = Store(order)
    context = store.boot('par-fan-two-stage-multi', candidate=True)
    assert store.execute(context) == {'ok': True, 'interrupted': True}
    assert [entry['fanout'] for entry in store.journal_at_return[:-1]] == [
        f'0/before.{key}/{call}' for key in LABELS for call in range(3)
    ]
    assert store.journal_at_return[-1]['kind'] == 'interaction'
    assert set(store.effects) == {
        f'dspy/{CONVERSATION}/1/0/before.{key}/1' for key in LABELS
    }
    assert store.orphans == store.after_termination == 0
