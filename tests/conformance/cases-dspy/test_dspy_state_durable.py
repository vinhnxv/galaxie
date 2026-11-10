# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Characterize state swaps through the native durable DSPy driver."""

import asyncio
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from types import ModuleType

import pytest


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


native = load_module('state_durable_native_driver', 'test_dspy_durable.py')
programs = load_module('state_durable_programs', 'state_durable.py')
FIXTURES = json.loads(Path(__file__).with_name('state-durable-fixtures.json').read_text())


class Store(native.Store):
    def boot(self, name, state_path):
        transport = ModuleType('_galaxie_transport')
        setattr(transport, 'request', self.request)
        setattr(transport, 'notify', self.notify)
        sys.modules[transport.__name__] = transport
        selected = ModuleType('state_durable_selected')
        setattr(selected, 'create_agent', lambda: programs.factory(name, state_path))
        sys.modules[selected.__name__] = selected
        context = {'_galaxie_module': selected.__name__, '_galaxie_entry': 'create_agent', '_galaxie_durable': True}
        exec(native.DRIVER, context)
        assert context['_galaxie_ready'] == {'ok': True}
        return context


def state_file(tmp_path, swap):
    definition = FIXTURES['swaps'][swap]
    source = Path(__file__).with_name('state') / (definition['state'] + '.json')
    text = source.read_text()
    if 'set' in definition:
        text = json.dumps({**json.loads(text), **definition['set']})
    path = tmp_path / (swap + '.json')
    path.write_text(text)
    return path


def checkpoint(store):
    return json.loads(base64.b64decode(list(store.rows.values())[-1]['checkpoint']['bytes']))


@pytest.mark.parametrize('scenario', FIXTURES['scenarios'], ids=lambda scenario: scenario['name'])
def test_state_swap_after_a_durable_pause(scenario, tmp_path):
    original = state_file(tmp_path, 'same')
    replacement = state_file(tmp_path, scenario['swap'])
    state = json.loads(replacement.read_text())
    store = Store()
    context = store.boot(scenario['program'], original)
    assert native.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    assert before is not None
    early = scenario['program'] == 'state-durable-early-model'
    assert store.calls == ['before'] and store.requests == int(early)
    context = store.boot(scenario['program'], replacement)
    assert native.pending(context) == before
    result = native.execute(context, before)
    assert store.calls == ['before'] and len(store.effects) == 1
    if scenario['outcome'] == 'completes':
        assert result == {'ok': True, 'output': {'answer': 'done', 'receipt': native.durable.PRIVATE_RESULT, 'demos': len(state['demos']), 'instructions': state['signature']['instructions']}}
        assert store.requests == int(early) + 1
        assert checkpoint(store)['status'] == 'completed'
    else:
        assert result == {'ok': False, 'code': 'unrecoverable'}
        assert store.requests == int(early)
        assert checkpoint(store)['status'] == 'unrecoverable'
        restored = store.boot(scenario['program'], original)
        restored['_galaxie_thread'] = 'session'
        assert json.loads(asyncio.run(restored['_galaxie_pending']())) == {'ok': False, 'code': 'unrecoverable'}


def test_state_bytes_and_journal_request_digests(tmp_path):
    journals = {}
    paths = {swap: state_file(tmp_path, swap) for swap in FIXTURES['swaps']}
    assert paths['same'].read_bytes() != paths['inert'].read_bytes()
    for program in programs.PROGRAMS:
        journals[program] = {}
        for swap, path in paths.items():
            store = Store()
            context = store.boot(program, path)
            assert native.execute(context) == {'ok': True, 'interrupted': True}
            journal = checkpoint(store)['journal']
            journals[program][swap] = journal
            if program == 'state-durable-fingerprint':
                assert journal[-1]['request']['props']['stateDigest'] == hashlib.sha256(path.read_bytes()).hexdigest()
    early = journals['state-durable-early-model']
    assert all(journal[0]['kind'] == 'model' for journal in early.values())
    assert early['same'][0]['digest'] == early['inert'][0]['digest']
    assert early['same'][0]['digest'] != early['prompt'][0]['digest']
    fingerprints = journals['state-durable-fingerprint']
    assert all(journal[-1]['kind'] == 'interaction' for journal in fingerprints.values())
    for swap in ('prompt', 'inert'):
        assert fingerprints['same'][-1]['digest'] != fingerprints[swap][-1]['digest']


def test_state_restore_fixture_references():
    scenarios = FIXTURES['scenarios']
    assert len({scenario['name'] for scenario in scenarios}) == len(scenarios)
    assert {scenario['program'] for scenario in scenarios} == set(programs.PROGRAMS)
    assert {scenario['swap'] for scenario in scenarios} == set(FIXTURES['swaps'])
    assert {scenario['outcome'] for scenario in scenarios} == {'completes', 'unrecoverable'}
