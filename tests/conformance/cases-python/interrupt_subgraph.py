# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio

from langgraph.graph import END, START, StateGraph

from fixture_support import REQUEST, ValueState, native_interaction

INPUT = {"value": 1}
SCRIPT = {}
RESUMES = [{"action": "submit", "payload": "inner answer"}]


def factory(checkpointer, model=None, capability=None, interaction=None):
    request = interaction if interaction is not None else native_interaction
    counts = {"callSub": 0, "s1": 0, "sask": 0}

    def s1(state):
        counts["s1"] += 1
        return {}

    async def sask(state, config):
        counts["sask"] += 1
        await asyncio.sleep(0)
        return {"answer": request(REQUEST, config)["payload"]}

    child = (StateGraph(ValueState).add_node("s1", s1).add_node("sask", sask)
        .add_edge(START, "s1").add_edge("s1", "sask").add_edge("sask", END).compile())

    async def call_sub(state, config):
        counts["callSub"] += 1
        return await child.ainvoke(state, config)

    return (StateGraph(ValueState).add_node("callSub", call_sub)
        .add_node("finish", lambda state: {"counts": dict(counts)})
        .add_edge(START, "callSub").add_edge("callSub", "finish").add_edge("finish", END)
        .compile(checkpointer=checkpointer))
