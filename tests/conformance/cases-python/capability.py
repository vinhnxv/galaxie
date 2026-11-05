# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

from langgraph.graph import END, START, StateGraph

from fixture_support import ValueState, native_capability

INPUT = {"value": 2}
SCRIPT = {}
RESUMES = []


def factory(checkpointer, model=None, capability=None, interaction=None):
    call = capability if capability is not None else native_capability

    async def double(state, config):
        return await call("double@1", {"value": state["value"]}, config)

    return (StateGraph(ValueState).add_node("double", double)
        .add_edge(START, "double").add_edge("double", END)
        .compile(checkpointer=checkpointer))
