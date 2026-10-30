# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from galaxie.capabilities import call
from fixture_support import REQUEST, native_interaction


class State(TypedDict, total=False):
    value: int
    answer: Any
    saved: bool


def factory(checkpointer, model=None, capability=None, interaction=None):
    invoke = capability or call
    ask = interaction or native_interaction

    def question(state, config):
        return {"answer": ask(REQUEST, config)["payload"]}

    child = (StateGraph(State).add_node("ask", question).add_edge(START, "ask")
             .add_edge("ask", END).compile())

    async def parent(state, config):
        await invoke("body@1", {}, config)
        receipt = await invoke("save@1", {"value": state["value"]}, config)
        result = await child.ainvoke(state, config)
        return {**result, "saved": receipt["saved"]}

    return (StateGraph(State).add_node("parent", parent).add_edge(START, "parent")
            .add_edge("parent", END).compile(checkpointer=checkpointer))
