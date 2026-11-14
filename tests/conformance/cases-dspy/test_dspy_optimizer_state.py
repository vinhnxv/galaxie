# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Independent native parity, optimizer provenance and portable-state facts."""

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

import dspy
from galaxie.dspy import Executor, GalaxieError
import pytest

import optimizer_state_native as native


@pytest.mark.parametrize('name', native.FIXTURES)
def test_optimizer_state_matches_native_golden(name):
    golden = Path(__file__).parents[1] / 'golden-dspy-optimizer-state' / f'{name}.json'
    assert asyncio.run(native.record(name)) == json.loads(golden.read_text())


@pytest.mark.parametrize('name', sorted({fixture['state'] for fixture in native.FIXTURES.values()}))
def test_optimizer_state_reproducible_and_nonvacuous(name):
    saved = json.loads((native.STATES / f'{name}.json').read_text())
    assert native.optimize(name) == saved
    assert native.optimize(name) == saved
    assert saved['signature']['instructions'] != native.suite.build(name).signature.instructions
    assert saved['signature']['instructions'] == native.FIXTURES[name]['proposals']['proposed_instruction']


@pytest.mark.parametrize('name', sorted({fixture['state'] for fixture in native.FIXTURES.values()}))
def test_optimizer_state_hygiene_and_prompt(name):
    path = native.STATES / f'{name}.json'
    saved = json.loads(path.read_text(encoding='utf-8'))
    assert saved['metadata']['dependency_versions']['dspy'] == dspy.__version__
    assert saved['lm'] is None
    assert path.stat().st_size < 64 * 1024
    assert 'not-a-real-key' not in path.read_text()
    def check(value):
        if isinstance(value, dict):
            assert 'api_key' not in value
            for child in value.values():
                check(child)
        elif isinstance(value, list):
            for child in value:
                check(child)
    check(saved)
    transcript = asyncio.run(native.record(name))
    system = transcript['requests'][0]['messages'][0]['content']
    assert saved['signature']['instructions'] in system
    if name == 'optstate-copro':
        assert saved['signature']['fields'][-1]['prefix'] == 'Offline capital:'
        assert 'Offline capital:' not in system
        assert saved['demos'] == []


def test_optimizer_state_missing_rebind_fails_before_network():
    module = native.suite.build('optstate-forgot-lm')
    module.load(native.STATES / f"{native.FIXTURES['optstate-forgot-lm']['state']}.json")
    with patch('socket.socket.connect', side_effect=AssertionError('No network is allowed.')), pytest.raises(GalaxieError) as caught:
        Executor(module)
    assert caught.value.code == 'unsupported'
    transcript = asyncio.run(native.record('optstate-forgot-lm'))
    assert transcript['requests'] == transcript['capabilities'] == []
    assert transcript['error'] == {'code': 'unsupported', 'message': 'This operation is unsupported.'}
