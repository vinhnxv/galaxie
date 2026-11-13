# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Regenerate or check independent service and host-bound retrieval transcripts."""

import asyncio
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'tests/conformance/cases-dspy'))
from golden_native import RETRIEVAL, record_retrieval

checking = '--check' in sys.argv
goldens = root / 'tests/conformance/golden-dspy-retrieval'
if not checking:
    goldens.mkdir(exist_ok=True)
for name, case in RETRIEVAL.items():
    value = asyncio.run(record_retrieval(name))
    path = goldens / case['golden']
    if checking:
        if json.loads(path.read_text()) != value:
            raise SystemExit(f'The DSPy retrieval reference differs: {name}')
    else:
        path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
print(f"{'Checked' if checking else 'Recorded'} {len(RETRIEVAL)} DSPy retrieval cases.")
