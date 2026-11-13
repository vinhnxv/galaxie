# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Check fixed provider-LM refusal transcripts; optionally initialize new files."""

import asyncio
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'tests/conformance/cases-dspy'))
from golden_native import PROVIDER_LM, record_provider_lm

if '--check' not in sys.argv:
    raise SystemExit('Pass --check; --write-new may initialize missing goldens only.')
goldens = root / 'tests/conformance/golden-dspy-provider-lm'
if '--write-new' in sys.argv:
    goldens.mkdir(exist_ok=True)
for name, case in PROVIDER_LM.items():
    value = asyncio.run(record_provider_lm(name))
    path = goldens / case['golden']
    if '--write-new' in sys.argv:
        try:
            with path.open('x') as target:
                target.write(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
        except FileExistsError:
            pass
    if json.loads(path.read_text()) != value:
        raise SystemExit(f'The DSPy provider LM reference differs: {name}')
print(f'Checked {len(PROVIDER_LM)} DSPy provider LM cases.')
