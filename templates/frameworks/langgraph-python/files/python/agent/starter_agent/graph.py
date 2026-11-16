# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

from typing import Any, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from galaxie.langchain import GalaxieChatModel
from galaxie.langgraph import checkpointer, request_interaction


class StarterState(TypedDict):
    result: str


def create_agent() -> CompiledStateGraph:
    model = GalaxieChatModel(role="comment")

    async def question(_state: StarterState, config: RunnableConfig) -> dict[str, Any]:
        submission = request_interaction({
            "surfaceId": "question",
            "component": "education.Quiz/v1",
            "viewRevision": "question-v1",
            "props": {
                "title": "A tiny local agent",
                "questions": [{
                    "id": "sum",
                    "prompt": "What is 2 + 2?",
                    "options": [
                        {"id": "four", "label": "4"},
                        {"id": "five", "label": "5"},
                    ],
                }],
            },
        }, config)
        reply = await model.ainvoke([
            SystemMessage(content="Give a brief, encouraging practice comment."),
            HumanMessage(content="Give one short encouraging sentence about practicing."),
        ], config)
        grade = "Correct." if submission["payload"]["answers"]["sum"] == "four" else "The answer is 4."
        return {"result": f"{grade} {reply.text}"}

    graph = StateGraph(StarterState)
    graph.add_node("question", question)
    graph.add_edge(START, "question")
    graph.add_edge("question", END)
    return graph.compile(checkpointer=checkpointer())
