# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from langgraph.graph import START, StateGraph

from fixture_support import ValueState

INPUT = {"value": 0}
SCRIPT = {}
RESUMES = []


def factory(checkpointer, model=None, capability=None, interaction=None):
    return (StateGraph(ValueState).add_node("loop", lambda state: {"value": state["value"] + 1})
        .add_edge(START, "loop").add_edge("loop", "loop")
        .compile(checkpointer=checkpointer))
