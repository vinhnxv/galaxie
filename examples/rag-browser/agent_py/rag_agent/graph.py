# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from typing import Any, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from galaxie.capabilities import call
from galaxie.langchain import GalaxieChatModel

from .citations import cite_answer
from .prompt import system_prompt, user_prompt


class RagInput(TypedDict):
    question: str
    mode: str


class RagOutput(TypedDict):
    answer: str
    citations: list[dict[str, Any]]


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
        return cite_answer(reply.content, state["passages"])

    graph = StateGraph(RagState, input_schema=RagInput, output_schema=RagOutput)
    graph.add_node("retrieve", retrieve)
    graph.add_node("generateAnswer", generate_answer)
    graph.add_edge(START, "retrieve")
    graph.add_edge("retrieve", "generateAnswer")
    graph.add_edge("generateAnswer", END)
    return graph.compile()
