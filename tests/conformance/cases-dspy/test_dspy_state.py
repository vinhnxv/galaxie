# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import importlib.util
import json
from pathlib import Path
import sys
from unittest.mock import patch

import dspy
import pytest
from galaxie.dspy import Executor, GalaxieError

spec = importlib.util.spec_from_file_location('dspy_state_native', Path(__file__).with_name('state_native.py'))
if spec is None or spec.loader is None:
    raise ImportError('The native state recorder cannot be loaded.')
native = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = native
spec.loader.exec_module(native)


@pytest.mark.parametrize('name', native.FIXTURES)
def test_state_matches_native_golden(name):
    golden = Path(__file__).parents[1] / 'golden-dspy-state' / f'{name}.json'
    assert asyncio.run(native.record(name)) == json.loads(golden.read_text())


@pytest.mark.parametrize('name', sorted({fixture['state'] for fixture in native.FIXTURES.values()}))
def test_state_reproducible_and_public(name):
    path = native.STATES / f'{name}.json'
    saved = json.loads(path.read_text(encoding='utf-8'))
    assert native.optimize(name) == saved
    assert native.optimize(name) == saved
    assert saved['metadata']['dependency_versions']['dspy'] == dspy.__version__
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


def test_saved_demos_reach_the_prompt_in_order():
    transcript = asyncio.run(native.record('state-predict-demos'))
    messages = transcript['requests'][0]['messages']
    assert [message['role'] for message in messages] == ['system', 'user', 'assistant', 'user', 'assistant', 'user']
    for index, row in enumerate(native.FIXTURES['state-predict-demos']['trainset'][:2]):
        assert row['question'] in messages[1 + 2 * index]['content']
        assert row['answer'] in messages[2 + 2 * index]['content']


def test_bootstrap_saves_reasoning_and_react_saves_both_predictors():
    state = native.optimize('state-chain-of-thought-bootstrap')
    assert len(state['predict']['demos']) == 2
    assert all(demo['reasoning'] for demo in state['predict']['demos'])
    state = native.optimize('state-react-demos')
    assert len(state['react']['demos']) == len(state['extract.predict']['demos']) == 2
    transcript = asyncio.run(native.record('state-react-demos'))
    assert transcript['capabilities'] == [{'name': 'docs.lookup@1', 'input': {'query': 'France'}}]
    assert transcript['output'] == {'answer': 'Paris'}


def test_instructions_and_description_load_but_chat_adapter_uses_field_names():
    state = native.optimize('state-instructions-only')
    assert state['demos'] == []
    predict = native.suite.build('state-instructions-only')
    predict.load_state(state)
    assert predict.signature.fields['answer'].json_schema_extra['prefix'] == 'Saved answer:'
    system = asyncio.run(native.record('state-instructions-only'))['requests'][0]['messages'][0]['content']
    assert 'Answer using the saved offline instruction.' in system
    assert 'The saved capital city.' in system
    assert 'Saved answer:' not in system


@pytest.mark.parametrize('name', ['state-hostile-lm', 'state-forgot-lm'])
def test_loaded_lm_fails_closed_before_network(name):
    with patch('socket.socket.connect', side_effect=AssertionError('State tests forbid network.')):
        path = native.STATES / f"{native.FIXTURES[name]['state']}.json"
        module = native.suite.program(name, None, None, path)
        if name == 'state-hostile-lm':
            assert not {'api_base', 'base_url', 'model_list'} & module.lm.kwargs.keys()
        with pytest.raises(GalaxieError) as caught:
            Executor(module)
        assert caught.value.code == 'unsupported'


def test_roundtrip_catalog_hazards():
    facts = native.suite.catalog(native.STATES / 'state-predict-demos.json')
    assert facts['pickle'] == facts['customLm'] == 'ValueError'
    assert facts['missingKey'] == 'KeyError'
    assert facts['missingKeyUnchanged'] is facts['extraKeyIgnored'] is True
    assert facts['demoType'] == facts['demoValueType'] == 'dict'
    assert facts['config'] == {'temperature': 0.25}
    assert facts['lmRestored'] is False
    assert facts['toolPreserved'] is True
    assert facts['maxIters'] == 3
    assert facts['versionsMatch'] is True
    assert facts['reorderedFields']['second']['prefix'] == 'First saved:'
    assert facts['reorderedFields']['first']['desc'] == 'Second saved description'
