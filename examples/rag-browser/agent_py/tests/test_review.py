# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from galaxie._bridge import install_transport
from rag_agent.graph import create_agent
from rag_agent.prompt import user_prompt


def test_review_pauses_after_retrieval_and_answers_with_only_kept_passages(monkeypatch):
    monkeypatch.setattr("rag_agent.graph.checkpointer", InMemorySaver)
    passages = [
        {"id": "drop", "title": "Dropped", "text": "Dropped private passage.", "score": 1},
        {"id": "keep", "title": "Kept", "text": "Kept private passage.", "score": 0.9},
    ]
    requests = []

    async def transport(raw):
        request = json.loads(raw)
        requests.append(request)
        payload = {"passages": passages} if request["op"] == "capability" else {"content": "Kept [1]."}
        return json.dumps({
            "v": request["v"], "kind": "response", "id": request["id"],
            "op": request["op"], "ok": True, "payload": payload,
        })

    install_transport(transport)

    async def run():
        graph = create_agent()
        config: RunnableConfig = {"configurable": {"thread_id": "review"}}
        await graph.ainvoke({"question": "Which passage?", "mode": "hybrid", "review": True}, config)
        saved = await graph.aget_state(config)
        interrupt = saved.tasks[0].interrupts[0]
        assert interrupt.value == {
            "surfaceId": "rag-review", "component": "rag.ReviewPassages/v1", "viewRevision": "review-v1",
            "props": {"passages": [{"id": p["id"], "title": p["title"]} for p in passages]},
        }
        assert len(requests) == 1
        assert requests[0]["payload"]["effectScope"].count("|") >= 1
        result = await graph.ainvoke(Command(resume={interrupt.id: {
            "action": "submit", "payload": {"keptIds": ["keep"]},
        }}), config)
        assert result == {"answer": "Kept [1].", "citations": [{
            "marker": 1, "passageId": "keep", "title": "Kept", "text": "Kept private passage.",
        }]}
        assert requests[-1]["payload"]["messages"][-1]["content"] == user_prompt("Which passage?", passages[1:])

    asyncio.run(run())
