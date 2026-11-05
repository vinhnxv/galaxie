# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Record or check the independently scripted DSPy reference transcripts."""

import asyncio
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'tests/conformance/cases-dspy'))
from native import FIXTURES, record

directory = root / 'tests/conformance/golden-dspy'
if '--check' not in sys.argv:
    directory.mkdir(exist_ok=True)
for name in FIXTURES:
    path = directory / f'{name}.json'
    transcript = asyncio.run(record(name))
    text = json.dumps(transcript, indent=2, ensure_ascii=False) + '\n'
    if '--check' in sys.argv:
        if json.loads(path.read_text()) != transcript:
            raise SystemExit(f'The DSPy reference differs: {name}')
    else:
        path.write_text(text)
print(f'Checked {len(FIXTURES)} native DSPy cases.' if '--check' in sys.argv else f'Recorded {len(FIXTURES)} native DSPy cases.')
