# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from langchain_core.messages import HumanMessage
from langgraph.graph import END, START, StateGraph

from fixture_support import ValueState, model_or_default

INPUT = {"value": 1}
SCRIPT = {"implicit request": {
    "id": "reply-implicit", "text": "implicit response",
    "usage": {"input_tokens": 2, "output_tokens": 2, "total_tokens": 4},
}}
RESUMES = []


def factory(checkpointer, model=None, capability=None, interaction=None):
    model = model_or_default(model, SCRIPT)

    async def implicit(state):
        reply = await model.ainvoke([HumanMessage(id="human-implicit", content="implicit request")])
        return {"answer": reply.content}

    return (StateGraph(ValueState).add_node("implicit", implicit)
        .add_edge(START, "implicit").add_edge("implicit", END)
        .compile(checkpointer=checkpointer))
