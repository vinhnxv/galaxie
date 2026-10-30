# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import json
from pathlib import Path

import pytest

from rag_agent.prompt import user_prompt

CASES = json.loads((Path(__file__).resolve().parents[2] / "test/fixtures/prompt-cases.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_shared_prompt_contract(case):
    assert user_prompt(case["question"], case["passages"]) == case["expected"]
