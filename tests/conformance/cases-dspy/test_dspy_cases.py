# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import importlib.util
import json
from pathlib import Path
import sys

import pytest
spec = importlib.util.spec_from_file_location('dspy_conformance_native', Path(__file__).with_name('native.py'))
if spec is None or spec.loader is None:
    raise ImportError('The conformance module cannot be loaded.')
native = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = native
spec.loader.exec_module(native)


@pytest.mark.parametrize('name', native.FIXTURES)
def test_native_dspy_matches_golden(name):
    expected = json.loads((Path(__file__).parents[1] / 'golden-dspy' / f'{name}.json').read_text())
    assert asyncio.run(native.record(name)) == expected
