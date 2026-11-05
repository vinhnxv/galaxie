# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from fixture_support import REQUEST, native_interaction

INPUT = {"value": 1}
SCRIPT = {}
RESUMES = [{"action": "submit", "payload": "first"}, {"action": "submit", "payload": False}]


class State(TypedDict):
    value: int
    first: Any
    second: Any
    counts: dict[str, int]


def factory(checkpointer, model=None, capability=None, interaction=None):
    request = interaction if interaction is not None else native_interaction
    counts = {"askFirst": 0, "askSecond": 0}

    def ask_first(state, config):
        counts["askFirst"] += 1
        return {"first": request(REQUEST, config)["payload"]}

    def ask_second(state, config):
        counts["askSecond"] += 1
        return {"second": request(REQUEST, config)["payload"]}

    return (StateGraph(State).add_node("askFirst", ask_first).add_node("askSecond", ask_second)
        .add_node("finish", lambda state: {"counts": dict(counts)})
        .add_edge(START, "askFirst").add_edge("askFirst", "askSecond")
        .add_edge("askSecond", "finish").add_edge("finish", END)
        .compile(checkpointer=checkpointer))
