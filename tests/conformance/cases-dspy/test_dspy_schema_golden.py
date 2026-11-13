# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""New-only native references and galaxie driver transcripts must match."""

import asyncio
import json
from pathlib import Path

from galaxie._bridge import ERROR_MESSAGES
import pytest

from schema_native import CASES, record_schema
from test_dspy_schema_output import Store, execute

GOLDENS = Path(__file__).parents[1] / 'golden-dspy-schema'


@pytest.mark.parametrize('name', CASES)
def test_schema_native_reference_and_driver_equal_golden(name):
    case = CASES[name]
    golden = json.loads((GOLDENS / case['golden']).read_text())
    assert asyncio.run(record_schema(name)) == golden
    store = Store(case['reply'])
    result = execute(store.boot_schema(name))
    code = result.get('code')
    actual = {
        'requests': [{'messages': value['messages'], **value['options']} for value in store.payloads],
        'responses': [{'content': case['reply'], 'toolCalls': []} for _ in store.payloads],
        'capabilities': [], 'interactions': [], 'output': result.get('output'),
        'error': {'code': code, 'message': ERROR_MESSAGES[code]} if code else None,
    }
    assert store.calls == []
    assert actual == golden


def test_schema_golden_family_is_exact():
    assert {path.name for path in GOLDENS.iterdir()} == {case['golden'] for case in CASES.values()}
