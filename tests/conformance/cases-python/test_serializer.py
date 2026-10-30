# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""Check the stand-in against the values actually serialized by the graphs."""

import asyncio
import json
import sys
from pathlib import Path

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

sys.path.insert(0, str(Path(__file__).resolve().parent))
import suite


def documented_decoded(value):
    # JsonPlusSerializer's msgpack default stores exceptions as repr strings;
    # msgpack arrays (including Python tuples) decode as lists. All other
    # checkpoint values retain their value, including reconstructed objects.
    if isinstance(value, BaseException):
        return repr(value)
    if isinstance(value, (list, tuple)):
        return [documented_decoded(item) for item in value]
    if isinstance(value, dict):
        return {key: documented_decoded(item) for key, item in value.items()}
    return value


def strictly_equal(left, right):
    if type(left) is not type(right):
        return False
    if isinstance(left, list):
        return len(left) == len(right) and all(strictly_equal(a, b) for a, b in zip(left, right))
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(strictly_equal(left[key], right[key]) for key in left)
    return left == right


class RoundTripSerializer(JsonPlusSerializer):
    def __init__(self):
        super().__init__()
        self.checked = 0
        self.mismatches = []

    def dumps_typed(self, value):
        encoded = super().dumps_typed(value)
        decoded = self.loads_typed(encoded)
        self.checked += 1
        if not strictly_equal(decoded, documented_decoded(value)):
            self.mismatches.append((value, decoded))
        return encoded


@pytest.mark.parametrize("name", suite.CASE_NAMES)
def test_checkpoint_values_round_trip_through_the_standin(name, monkeypatch):
    serializer = RoundTripSerializer()
    monkeypatch.setattr(suite, "InMemorySaver", lambda: InMemorySaver(serde=serializer))
    transcript = asyncio.run(suite.record_case(name))
    expected = (
        {"status": "failed", "errorType": "FixtureModelError"} if name == "model-failure"
        else {"status": "failed", "errorType": "GraphRecursionError"} if name == "step-limit"
        else {"status": "succeeded"}
    )
    assert transcript["outcome"] == expected
    assert serializer.checked > 0
    assert serializer.mismatches == []


def test_rag_checkpoint_values_round_trip_through_the_standin(monkeypatch):
    from galaxie._bridge import install_transport

    directory = Path(__file__).resolve().parents[3] / "examples" / "rag-browser"
    monkeypatch.syspath_prepend(str(directory / "agent_py"))
    from rag_agent import graph as rag

    script = json.loads((directory / "test" / "golden" / "script.json").read_text())
    expected = json.loads((directory / "test" / "golden" / "session.json").read_text())
    serializer = RoundTripSerializer()
    monkeypatch.setattr(rag, "checkpointer", lambda: InMemorySaver(serde=serializer))

    async def run():
        for index, item in enumerate(script["session"]):
            async def transport(raw):
                request = json.loads(raw)
                reply = (item["search"] if request["op"] == "capability"
                         else {"content": item["model"]["reply"]})
                return json.dumps({
                    "v": request["v"], "kind": "response", "id": request["id"],
                    "op": request["op"], "ok": True, "payload": reply,
                })

            install_transport(transport)
            graph = rag.create_agent()
            config = {"configurable": {"thread_id": f"rag-serializer-{index}"}}
            output = await graph.ainvoke(item["input"], config)
            assert output == [entry["output"] for entry in expected if entry["type"] == "output"][index]
            state = await graph.aget_state(config)
            assert state.values["passages"] == item["search"]["passages"]
            assert state.values["question"] == item["input"]["question"]

    asyncio.run(run())
    assert serializer.checked > 0
    assert serializer.mismatches == []


def test_parent_effect_checkpoint_values_round_trip_through_the_standin():
    from langgraph.types import Command
    from parent_effects import factory

    serializer = RoundTripSerializer()

    async def capability(name, value, config):
        return {"saved": True}

    async def run():
        graph = factory(InMemorySaver(serde=serializer), capability=capability)
        config = {"configurable": {"thread_id": "serializer-effects"}}
        await graph.ainvoke({"value": 1}, config)
        state = await graph.aget_state(config)
        identifier = state.tasks[0].interrupts[0].id
        result = await graph.ainvoke(Command(resume={identifier: {"action": "submit", "payload": False}}), config)
        assert result == {"value": 1, "answer": False, "saved": True}

    asyncio.run(run())
    assert serializer.checked > 0
    assert serializer.mismatches == []


def test_nested_effect_checkpoint_values_round_trip_through_the_standin():
    from langgraph.types import Command
    from effect_scopes import factory
    from fixture_support import native_interaction

    serializer = RoundTripSerializer()
    identifier = "00000000-0000-4000-8000-000000000001"

    async def capability(name, value, config):
        return {"effectId": identifier}

    async def run():
        graph = factory(InMemorySaver(serde=serializer), capability, native_interaction)
        config = {"configurable": {"thread_id": "serializer-nested-effects"}}
        await graph.ainvoke({}, config)
        state = await graph.aget_state(config)
        pending = state.tasks[0].interrupts[0].id
        result = await graph.ainvoke(Command(resume={pending: {"action": "submit", "payload": False}}), config)
        assert result == {"ids": [identifier] * 3, "answer": False}

    asyncio.run(run())
    assert serializer.checked > 0
    assert serializer.mismatches == []
