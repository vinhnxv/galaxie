# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import importlib
import json
import sys
from pathlib import Path

import pytest

DIRECTORY = Path(__file__).resolve().parent
sys.path.insert(0, str(DIRECTORY))
from suite import CASE_NAMES, record_case, record_reload


@pytest.mark.parametrize("name", CASE_NAMES)
def test_native_case_matches_its_python_golden(name):
    actual = asyncio.run(record_case(name))
    expected_outcome = (
        {"status": "failed", "errorType": "FixtureModelError"} if name == "model-failure"
        else {"status": "failed", "errorType": "GraphRecursionError"} if name == "step-limit"
        else {"status": "succeeded"}
    )
    assert actual["outcome"] == expected_outcome
    expected = json.loads((DIRECTORY.parent / "golden-python" / f"{name}.json").read_text())
    assert actual == expected


@pytest.mark.parametrize("name", [
    "interrupt-resume", "interrupt-durability-sync", "interrupt-durability-exit",
])
def test_interrupting_node_reexecutes_but_completed_node_does_not(name):
    transcript = asyncio.run(record_case(name))
    assert transcript["final"] == {
        "value": 1, "answer": {"answer": "yes"}, "counts": {"prepare": 1, "ask": 2},
    }
    assert len(transcript["pauses"]) == 1
    assert transcript["pauses"][0]["interrupts"][0]["value"] == {
        "surfaceId": "main", "viewRevision": "r1", "component": "conformance.Question/v1",
        "props": {"question": "Continue?"},
    }


def test_sequential_interrupts_have_distinct_ids_and_preserve_false_payload():
    transcript = asyncio.run(record_case("interrupt-sequence"))
    assert transcript["final"] == {
        "value": 1, "first": "first", "second": False,
        "counts": {"askFirst": 2, "askSecond": 2},
    }
    assert [pause["interrupts"][0]["id"] for pause in transcript["pauses"]] == [
        "<interrupt:1>", "<interrupt:2>",
    ]


@pytest.mark.parametrize("name", [
    "interrupt-resume", "interrupt-durability-sync", "interrupt-durability-exit",
    "interrupt-subgraph",
])
def test_reconstructed_graph_resumes_only_the_unfinished_nodes(name):
    transcript = asyncio.run(record_reload(name))
    expected_counts = (
        {"callSub": 1, "s1": 0, "sask": 1}
        if name == "interrupt-subgraph" else {"prepare": 0, "ask": 1}
    )
    assert transcript["final"]["counts"] == expected_counts
    assert transcript["samePending"] is True
    assert transcript["repeatedFinal"] == transcript["final"]
    assert transcript["repeatedUpdates"] == []
    expected = json.loads((DIRECTORY.parent / "golden-python" / "reload" / f"{name}.json").read_text())
    assert transcript == expected


def test_all_twelve_reference_cases_are_present():
    assert len(CASE_NAMES) == 12
    for name in CASE_NAMES:
        case = importlib.import_module(name.replace("-", "_"))
        assert callable(case.factory)


def test_branching_transcript_is_reproducible_across_runs():
    async def repeated():
        expected = await record_case("branching")
        for _ in range(20):
            assert await record_case("branching") == expected

    asyncio.run(repeated())


def test_unknown_case_has_a_fixed_error():
    with pytest.raises(ValueError, match="^The conformance case is unknown\\.$"):
        asyncio.run(record_case("missing"))
