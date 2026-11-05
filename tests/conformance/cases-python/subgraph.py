# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

from langgraph.graph import END, START, StateGraph

from fixture_support import ValueState

INPUT = {"value": 3}
SCRIPT = {}
RESUMES = []


def factory(checkpointer, model=None, capability=None, interaction=None):
    def increment(state: ValueState) -> dict[str, int]:
        return {"value": state["value"] + 1}

    child = (StateGraph(ValueState)
        .add_node("increment", increment)
        .add_edge(START, "increment").add_edge("increment", END).compile())
    return (StateGraph(ValueState).add_node("child", child)
        .add_edge(START, "child").add_edge("child", END)
        .compile(checkpointer=checkpointer))
