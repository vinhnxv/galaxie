# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from typing import Any, TypedDict

from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph

from fixture_support import REQUEST


class State(TypedDict):
    ids: list[str]
    answer: Any


def factory(checkpointer, capability, interaction, **kwargs):
    async def save(config):
        receipt = await capability("save@1", {"value": 1}, config)
        get_stream_writer()({
            "scope": config["metadata"]["langgraph_checkpoint_ns"],
            "effectId": receipt["effectId"],
        })
        return receipt["effectId"]

    async def write(state, config):
        identifier = await save(config)
        answer = interaction(REQUEST, config)
        return {"ids": [identifier], "answer": answer["payload"]}

    grandchild = (StateGraph(State).add_node("write", write)
        .add_edge(START, "write").add_edge("write", END).compile())
    child = (StateGraph(State).add_node("child", grandchild)
        .add_edge(START, "child").add_edge("child", END).compile())

    async def parent(state, config):
        first = await save(config)
        second = await save(config)
        result = await child.ainvoke(state, config)
        return {**result, "ids": [first, second, *result["ids"]]}

    return (StateGraph(State).add_node("parent", parent)
        .add_edge(START, "parent").add_edge("parent", END)
        .compile(checkpointer=checkpointer))
