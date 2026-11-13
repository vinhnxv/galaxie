# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Replay each committed transcript through the independent plain-DSPy twin."""

import asyncio
import json
from pathlib import Path

import pytest

from golden_native import RETRIEVAL, RUNTIME, record_retrieval, record_runtime


@pytest.mark.parametrize('family,cases,recorder', [
    ('runtime', RUNTIME, record_runtime), ('retrieval', RETRIEVAL, record_retrieval),
])
def test_native_golden_family(family, cases, recorder):
    directory = Path(__file__).parent.parent / f'golden-dspy-{family}'
    assert {path.name for path in directory.glob('*.json')} == {case['golden'] for case in cases.values()}
    for name, case in cases.items():
        assert asyncio.run(recorder(name)) == json.loads((directory / case['golden']).read_text()), name


def test_runtime_demos_and_replay_frontier():
    single = asyncio.run(record_runtime('rt-opt-labeled'))
    assert single['error'] is None
    assert single['output'] == {'answer': 'Paris', 'demos': [
        {'question': 'Capital of Japan?', 'answer': 'Tokyo'},
        {'question': 'Capital of Italy?', 'answer': 'Rome'},
    ]}
    resumed = asyncio.run(record_runtime('rt-opt-labeled-two-stage'))
    assert resumed['error'] is None
    assert len(resumed['requests']) == len(resumed['responses']) == 2
    assert len(resumed['interactions']) == 1
    assert resumed['responses'][0] != resumed['responses'][1]
    assert resumed['output'] == {**single['output'], 'first': 'Paris', 'answer': 'Reviewed Paris'}
    assert resumed['events'] == [
        {'mode': 'updates', 'data': {'kind': 'pause'}},
        {'mode': 'updates', 'data': {'kind': 'replayed', 'count': 2}},
    ]


def test_retrieval_boundaries():
    local = asyncio.run(record_retrieval('pe-retrieve-local-rm'))
    assert local['requests'] == local['capabilities'] == []
    assert local['output'] == {'passages': ['local a', 'local b']}
    colbert = asyncio.run(record_retrieval('pe-retrieve-colbert'))
    assert colbert == {'requests': [], 'responses': [], 'capabilities': [], 'interactions': [],
                       'output': None, 'error': {'code': 'executor_error', 'message': 'The executor or agent code failed.'}}
    rag = asyncio.run(record_retrieval('rag-docs-search'))
    case = RETRIEVAL['rag-docs-search']
    assert rag['error'] is None
    assert rag['capabilities'] == [{'name': 'docs.search@1', 'input': {
        'query': case['input']['question'], 'mode': case['input']['mode'], 'k': 10,
    }}]
    assert rag['output']['passages'] == case['capability']['result']['passages']
