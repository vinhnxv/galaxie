# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from langchain_core.messages import HumanMessage
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph

from fixture_support import ValueState, model_or_default

INPUT = {"value": 2}
SCRIPT = {"linear request": {
    "id": "reply-linear", "text": "linear response",
    "usage": {"input_tokens": 2, "output_tokens": 2, "total_tokens": 4},
}}
RESUMES = []


def factory(checkpointer, model=None, capability=None, interaction=None):
    model = model_or_default(model, SCRIPT)

    async def respond(state, config):
        get_stream_writer()({"phase": "respond", "value": state["value"]})
        reply = await model.ainvoke([
            HumanMessage(id="human-linear", content="linear request"),
        ], config)
        return {"value": state["value"] + 1, "answer": reply.content}

    def double(state: ValueState) -> dict[str, int]:
        return {"value": state["value"] * 2}

    return (StateGraph(ValueState)
        .add_node("respond", respond)
        .add_node("double", double)
        .add_edge(START, "respond").add_edge("respond", "double").add_edge("double", END)
        .compile(checkpointer=checkpointer))
