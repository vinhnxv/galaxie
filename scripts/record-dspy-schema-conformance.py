# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Check schema-output transcripts; initialize only missing golden files."""

import asyncio
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'tests/conformance/cases-dspy'))
from schema_native import CASES, record_schema

if '--check' not in sys.argv:
    raise SystemExit('Pass --check; --write-new may initialize missing goldens only.')
goldens = root / 'tests/conformance/golden-dspy-schema'
if '--write-new' in sys.argv:
    goldens.mkdir(exist_ok=True)
for name, case in CASES.items():
    value = asyncio.run(record_schema(name))
    path = goldens / case['golden']
    if '--write-new' in sys.argv:
        try:
            with path.open('x') as target:
                target.write(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
        except FileExistsError:
            pass
    if json.loads(path.read_text()) != value:
        raise SystemExit(f'The DSPy schema reference differs: {name}')
print(f'Checked {len(CASES)} DSPy schema cases.')
