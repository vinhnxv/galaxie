# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from galaxie import GalaxieError
from galaxie import langgraph

REQUEST = {
    "surfaceId": "main", "viewRevision": "r1", "component": "conformance.Question/v1",
    "props": {"question": "Continue?"},
}


def test_request_interaction_pauses_after_await_and_resumes_by_id():
    async def scenario():
        async def ask(state, config):
            await asyncio.sleep(0)
            return langgraph.request_interaction(REQUEST, config)

        graph = (StateGraph(dict).add_node("ask", ask).add_edge(START, "ask")
            .add_edge("ask", END).compile(checkpointer=InMemorySaver()))
        config = {"configurable": {"thread_id": "interaction-test"}}
        await graph.ainvoke({}, config)
        state = await graph.aget_state(config)
        pending = state.tasks[0].interrupts[0]
        assert pending.value == REQUEST
        answer = {"action": "submit", "payload": False}
        assert await graph.ainvoke(Command(resume={pending.id: answer}), config) == answer
        assert (await graph.aget_state(config)).next == ()

    asyncio.run(scenario())


@pytest.mark.parametrize("value", [None, {}, {**REQUEST, "extra": True},
    {**REQUEST, "props": []}, {**REQUEST, "surfaceId": ""}, {**REQUEST, "component": 42}])
def test_invalid_request_fails_before_calling_interrupt(value):
    with pytest.raises(GalaxieError, match="^The request is invalid\\.$") as error:
        langgraph.request_interaction(value, {})
    assert error.value.code == "invalid"


def test_checkpointer_requires_worker_configuration():
    with pytest.raises(GalaxieError, match="^The requested service is unavailable\\.$") as error:
        langgraph.checkpointer()
    assert error.value.code == "unavailable"


def test_checkpointer_returns_the_injected_object(monkeypatch):
    saver = InMemorySaver()
    monkeypatch.setattr(langgraph, "_checkpointer", None)
    langgraph._install_checkpointer(saver)
    assert langgraph.checkpointer() is saver
