# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from langchain_core.messages import HumanMessage
from langgraph.graph import END, START, StateGraph

from fixture_support import ValueState, model_or_default

INPUT = {"value": 1}
SCRIPT = {"failure request": {"error": "The conformance fixture failed."}}
RESUMES = []


def factory(checkpointer, model=None, capability=None, interaction=None):
    model = model_or_default(model, SCRIPT)

    async def fail(state, config):
        reply = await model.ainvoke([HumanMessage(id="human-failure", content="failure request")], config)
        return {"answer": reply.content}

    return (StateGraph(ValueState).add_node("fail", fail)
        .add_edge(START, "fail").add_edge("fail", END)
        .compile(checkpointer=checkpointer))
