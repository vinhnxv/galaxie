# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import operator
from typing import Annotated, TypedDict

from langgraph.graph import END, START, StateGraph

INPUT = {"route": "both"}
SCRIPT = {}
RESUMES = []


class State(TypedDict):
    route: str
    visits: Annotated[list[str], operator.add]


def factory(checkpointer, model=None, capability=None, interaction=None):
    async def left(state):
        return {"visits": ["left"]}

    async def right(state):
        return {"visits": ["right"]}

    return (StateGraph(State)
        .add_node("left", left)
        .add_node("right", right)
        .add_conditional_edges(START, lambda state: ["left", "right"] if state["route"] == "both" else ["left"])
        .add_edge("left", END).add_edge("right", END)
        .compile(checkpointer=checkpointer))
