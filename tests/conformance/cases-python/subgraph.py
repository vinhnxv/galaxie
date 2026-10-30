# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from langgraph.graph import END, START, StateGraph

from fixture_support import ValueState

INPUT = {"value": 3}
SCRIPT = {}
RESUMES = []


def factory(checkpointer, model=None, capability=None, interaction=None):
    child = (StateGraph(ValueState)
        .add_node("increment", lambda state: {"value": state["value"] + 1})
        .add_edge(START, "increment").add_edge("increment", END).compile())
    return (StateGraph(ValueState).add_node("child", child)
        .add_edge(START, "child").add_edge("child", END)
        .compile(checkpointer=checkpointer))
