# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import importlib.util
import json
from pathlib import Path
import sys

import pytest

directory = Path(__file__).parent
spec = importlib.util.spec_from_file_location('delegation_native_conformance', directory / 'delegation_native.py')
if spec is None or spec.loader is None:
    raise ImportError('The delegation reference cannot be loaded.')
native = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = native
spec.loader.exec_module(native)


@pytest.mark.parametrize('name', native.suite.CASES)
def test_native_delegation_transcript(name):
    expected = json.loads((directory.parent / 'golden-pydantic-ai-delegation' / f'{name}.json').read_text())
    assert asyncio.run(native.run_case(name)) == expected


@pytest.mark.parametrize('name', native.RELOAD_CASES)
def test_native_delegation_reload_preserves_conversation_and_usage(name):
    expected = json.loads((directory.parent / 'golden-pydantic-ai-delegation' / f'{name}.json').read_text())
    assert asyncio.run(native.run_case(name, reload=True)) == expected
