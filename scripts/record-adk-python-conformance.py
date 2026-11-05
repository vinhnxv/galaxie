# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import argparse
import asyncio
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'tests/conformance/cases-adk-python'))
from native import run_case
from suite import CASES


async def main(check):
    directory = root / 'tests/conformance/golden-adk-python'
    if not check:
        directory.mkdir(exist_ok=True)
    for name in CASES:
        path = directory / f'{name}.json'
        transcript = await run_case(name)
        encoded = json.dumps(transcript, ensure_ascii=False, indent=2) + '\n'
        if check:
            if not path.exists() or json.loads(path.read_text()) != transcript:
                raise SystemExit(f'The native adk-python transcript changed: {name}')
        else:
            path.write_text(encoded)
        print(f'{name}: {"verified" if check else "recorded"}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    asyncio.run(main(parser.parse_args().check))
