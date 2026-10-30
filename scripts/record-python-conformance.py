# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""Record the native CPython reference; run with python/.venv/bin/python -I."""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests" / "conformance" / "cases-python"))
os.environ["LANGSMITH_TRACING"] = "false"
os.environ["LANGCHAIN_TRACING_V2"] = "false"

from suite import CASE_NAMES, record_case


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify existing goldens without writing.")
    arguments = parser.parse_args()
    directory = ROOT / "tests" / "conformance" / "golden-python"
    if not arguments.check:
        directory.mkdir(parents=True, exist_ok=True)
    for name in CASE_NAMES:
        encoded = json.dumps(await record_case(name), ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        path = directory / f"{name}.json"
        if arguments.check:
            if path.read_text() != encoded:
                raise SystemExit(f"The native Python golden differs: {name}.")
        else:
            path.write_text(encoded)
        print(f"{'Verified' if arguments.check else 'Recorded'} {name}")


if __name__ == "__main__":
    asyncio.run(main())
