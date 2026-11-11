# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import argparse
import asyncio
import importlib.util
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
directory = root / 'tests/conformance/cases-pydantic-ai-child-approval'
sys.path.insert(0, str(directory))
spec = importlib.util.spec_from_file_location('child_approval_recorder_native', directory / 'child_approval_native.py')
if spec is None or spec.loader is None:
    raise ImportError('The child approval reference cannot be loaded.')
native = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = native
spec.loader.exec_module(native)


async def main(check):
    directory = root / 'tests/conformance/golden-pydantic-ai-child-approval'
    if not check:
        directory.mkdir(exist_ok=True)
    for name in native.suite.CASES:
        path = directory / f'{name}.json'
        transcript = await native.run_case(name)
        encoded = json.dumps(transcript, ensure_ascii=False, indent=2) + '\n'
        if check:
            if not path.exists() or json.loads(path.read_text()) != transcript:
                raise SystemExit(f'The native child approval transcript changed: {name}')
        else:
            path.write_text(encoded)
        print(f'{name}: {"verified" if check else "recorded"}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    asyncio.run(main(parser.parse_args().check))
