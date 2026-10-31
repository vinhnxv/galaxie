# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from typing import Any, NotRequired, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from galaxie.capabilities import call
from galaxie.langchain import GalaxieChatModel
from galaxie.langgraph import checkpointer, request_interaction

from .citations import cite_answer
from .prompt import system_prompt, user_prompt


class RagInput(TypedDict):
    question: str
    mode: str
    review: NotRequired[bool]


class RagOutput(TypedDict):
    answer: str
    citations: list[dict[str, Any]]
    sources: list[dict[str, Any]]


class RagState(RagInput, RagOutput):
    passages: list[dict[str, Any]]


def create_agent() -> CompiledStateGraph:
    model = GalaxieChatModel(role="rag.answer")

    async def retrieve(state: RagState, config: RunnableConfig) -> dict[str, Any]:
        return await call(
            "docs.search@1", {"query": state["question"], "mode": state["mode"], "k": 10}, config
        )

    async def generate_answer(state: RagState, config: RunnableConfig) -> dict[str, Any]:
        reply = await model.ainvoke([
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt(state["question"], state["passages"])),
        ], config)
        return cite_answer(reply.text, state["passages"])

    def review_passages(state: RagState, config: RunnableConfig) -> dict[str, Any]:
        submission = request_interaction({
            "surfaceId": "rag-review", "component": "rag.ReviewPassages/v1", "viewRevision": "review-v1",
            "props": {"passages": [{"id": p["id"], "title": p["title"]} for p in state["passages"]]},
        }, config)
        kept = submission["payload"]["keptIds"]
        return {"passages": [p for p in state["passages"] if p["id"] in kept]}

    retrieval = StateGraph(RagState)
    retrieval.add_node("retrieve", retrieve)
    retrieval.add_edge(START, "retrieve")
    retrieval.add_edge("retrieve", END)
    graph = StateGraph(RagState, input_schema=RagInput, output_schema=RagOutput)
    graph.add_node("retrieve", retrieve)
    graph.add_node("retrieval", retrieval.compile())
    graph.add_node("reviewPassages", review_passages)
    graph.add_node("generateAnswer", generate_answer)
    graph.add_conditional_edges(START, lambda state: "retrieval" if state.get("review") else "retrieve", ["retrieval", "retrieve"])
    graph.add_edge("retrieval", "reviewPassages")
    graph.add_edge("reviewPassages", "generateAnswer")
    graph.add_edge("retrieve", "generateAnswer")
    graph.add_edge("generateAnswer", END)
    return graph.compile(checkpointer=checkpointer())
