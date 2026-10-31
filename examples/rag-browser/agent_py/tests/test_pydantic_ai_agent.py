# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json

import pytest

from galaxie import GalaxieError
from galaxie._bridge import install_transport
from rag_pydantic_ai.agent import create_agent


PASSAGES = [
    {"id": "drop", "title": "Dropped", "text": "Dropped private passage.", "score": 1},
    {"id": "keep", "title": "Kept", "text": "Kept private passage.", "score": 0.9},
]


def tool(name, arguments, identifier):
    return {"content": "", "toolCalls": [{
        "id": identifier, "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }]}


def transport_for(replies, seen):
    scripted = iter(replies)

    async def transport(raw):
        request = json.loads(raw)
        seen.append(request)
        payload = {"passages": PASSAGES} if request["op"] == "capability" else next(scripted)
        return json.dumps({**request, "kind": "response", "ok": True, "payload": payload})

    install_transport(transport)


def test_retrieval_and_citations_use_the_broker_result():
    seen = []
    transport_for([
        tool("search_docs", {"query": "Which passage?", "mode": "hybrid", "k": 10}, "search"),
        {"content": "Kept [2]. Invalid [9]."},
    ], seen)
    result = asyncio.run(create_agent().run({"question": "Which passage?", "mode": "hybrid"}, "rag", 5))
    assert result == {"answer": "Kept [2]. Invalid .", "citations": [{
        "marker": 2, "passageId": "keep", "title": "Kept", "text": "Kept private passage.",
    }], "sources": [{"passageId": "drop", "title": "Dropped", "text": "Dropped private passage."}, {"passageId": "keep", "title": "Kept", "text": "Kept private passage."}]}
    capability = [request["payload"] for request in seen if request["op"] == "capability"]
    assert len(capability) == 1
    assert capability[0]["name"] == "docs.search@1"
    assert capability[0]["input"] == {"query": "Which passage?", "mode": "hybrid", "k": 10}
    assert capability[0]["effectScope"].startswith("pydantic-ai/rag/")


def paused_review():
    seen = []
    transport_for([
        tool("search_docs", {"query": "Which passage?", "mode": "hybrid", "k": 10}, "search"),
        tool("review_passages", {}, "review"),
    ], seen)
    executor = create_agent()
    assert asyncio.run(executor.run({"question": "Which passage?", "mode": "hybrid", "review": True}, "review", 5)) is None
    pending = executor.pending("review")
    assert pending is not None
    assert pending["value"] == {
        "surfaceId": "rag-review", "component": "rag.ReviewPassages/v1", "viewRevision": "review-v1",
        "props": {"passages": [{"id": p["id"], "title": p["title"]} for p in PASSAGES]},
    }
    return executor, pending


def test_review_restores_then_cites_only_kept_broker_passages():
    original, pending = paused_review()
    checkpoint, metadata = original._snapshot("review", "session")
    restored = create_agent()
    assert restored._restore(checkpoint, metadata, "session") == "review"
    assert restored.pending("review") == pending
    seen = []
    transport_for([{"content": "Kept [1]. Invalid [2]."}], seen)
    result = asyncio.run(restored.run(None, "review", 5, resume={
        "interactionId": pending["id"], "action": "submit", "payload": {"keptIds": ["keep"]},
    }))
    assert result == {"answer": "Kept [1]. Invalid .", "citations": [{
        "marker": 1, "passageId": "keep", "title": "Kept", "text": "Kept private passage.",
    }], "sources": [{"passageId": "keep", "title": "Kept", "text": "Kept private passage."}]}
    assert all(request["op"] != "capability" for request in seen)
    returns = [message for message in seen[-1]["payload"]["messages"] if message["role"] == "tool"]
    assert json.loads(returns[-1]["content"]) == {"passages": PASSAGES[1:]}


@pytest.mark.parametrize("action,payload", [
    ("approve", {"keptIds": ["keep"]}),
    ("submit", {"keptIds": ["forged"]}),
    ("submit", {"keptIds": ["keep", "keep"]}),
    ("submit", {}),
    ("submit", {"keptIds": ["keep"], "extra": True}),
])
def test_review_resume_fails_closed(action, payload):
    executor, pending = paused_review()
    seen = []
    transport_for([], seen)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run(None, "review", 5, resume={
            "interactionId": pending["id"], "action": action, "payload": payload,
        }))
    assert error.value.code == "invalid"
    assert seen == []


def test_injected_review_call_cannot_add_a_default_flow_interaction():
    seen = []
    transport_for([
        tool("search_docs", {"query": "instructions", "mode": "fulltext", "k": 10}, "search"),
        tool("review_passages", {}, "injected"),
    ], seen)
    executor = create_agent()
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run({"question": "instructions", "mode": "fulltext"}, "default", 5))
    assert error.value.code == "invalid"
    assert executor.pending("default") is None
