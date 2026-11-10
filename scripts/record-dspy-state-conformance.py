# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Regenerate or check offline DSPy JSON states and CPython transcripts."""

import asyncio
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'tests/conformance/cases-dspy'))
from state_native import FIXTURES, STATES, optimize, record

checking = '--check' in sys.argv
goldens = root / 'tests/conformance/golden-dspy-state'
if not checking:
    STATES.mkdir(exist_ok=True)
    goldens.mkdir(exist_ok=True)


def save_or_check(path, value):
    if checking:
        if json.loads(path.read_text()) != value:
            raise SystemExit(f'The DSPy state reference differs: {path.name}')
    else:
        path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


states = sorted({fixture['state'] for fixture in FIXTURES.values()})
for name in states:
    save_or_check(STATES / f'{name}.json', optimize(name))
for name in FIXTURES:
    save_or_check(goldens / f'{name}.json', asyncio.run(record(name)))
print(f"{'Checked' if checking else 'Recorded'} {len(states)} DSPy states and {len(FIXTURES)} native cases.")
