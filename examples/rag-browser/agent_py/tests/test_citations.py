# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import json
from pathlib import Path

import pytest

from rag_agent.citations import cite_answer

CASES = json.loads((Path(__file__).resolve().parents[2] / "test/fixtures/citation-cases.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_shared_citation_contract(case):
    assert cite_answer(case["reply"], case["passages"]) == case["expected"]
