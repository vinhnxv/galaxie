# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

from langgraph.graph import START, StateGraph

from fixture_support import ValueState

INPUT = {"value": 0}
SCRIPT = {}
RESUMES = []


def factory(checkpointer, model=None, capability=None, interaction=None):
    def loop(state: ValueState) -> dict[str, int]:
        return {"value": state["value"] + 1}

    return (StateGraph(ValueState).add_node("loop", loop)
        .add_edge(START, "loop").add_edge("loop", "loop")
        .compile(checkpointer=checkpointer))
