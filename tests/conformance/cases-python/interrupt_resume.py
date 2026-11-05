# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio

from langgraph.graph import END, START, StateGraph

from fixture_support import REQUEST, ValueState, native_interaction

INPUT = {"value": 1}
SCRIPT = {}
RESUMES = [{"action": "submit", "payload": {"answer": "yes"}}]


def create_graph(checkpointer, interaction=None, durability=None):
    request = interaction if interaction is not None else native_interaction
    counts = {"prepare": 0, "ask": 0}

    def prepare(state):
        counts["prepare"] += 1
        return {}

    async def ask(state, config):
        counts["ask"] += 1
        await asyncio.sleep(0)
        return {"answer": request(REQUEST, config)["payload"]}

    graph = (StateGraph(ValueState)
        .add_node("prepare", prepare).add_node("ask", ask)
        .add_node("finish", lambda state: {"counts": dict(counts)})
        .add_edge(START, "prepare").add_edge("prepare", "ask")
        .add_edge("ask", "finish").add_edge("finish", END)
        .compile(checkpointer=checkpointer))
    if durability is not None:
        # Pinned LangGraph Python resolves inherited durability from configurable.
        graph = graph.with_config({"configurable": {"__pregel_durability": durability}})
    return graph


def factory(checkpointer, model=None, capability=None, interaction=None):
    return create_graph(checkpointer, interaction)
