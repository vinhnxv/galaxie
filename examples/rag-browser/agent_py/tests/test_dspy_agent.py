# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json

import pytest

from galaxie import GalaxieError
from galaxie._bridge import install_transport
from rag_dspy.agent import create_agent


PASSAGES = [
    {"id": "drop", "title": "Dropped", "text": "Dropped private passage.", "score": 1},
    {"id": "keep", "title": "Kept", "text": "Kept private passage.", "score": 0.9},
]


def transport_for(answer, seen):
    async def transport(raw):
        request = json.loads(raw)
        seen.append(request)
        payload = {"passages": PASSAGES} if request["op"] == "capability" else {
            "content": f"[[ ## reasoning ## ]]\nHidden rationale.\n[[ ## answer ## ]]\n{answer}\n[[ ## completed ## ]]",
        }
        return json.dumps({**request, "kind": "response", "ok": True, "payload": payload})
    install_transport(transport)


def test_program_owns_retrieval_arguments_and_citation_projection():
    seen = []
    transport_for("Kept [2]. Invalid [9].", seen)
    result = asyncio.run(create_agent().run({"question": "Which passage?", "mode": "hybrid"}, "rag", 5))
    assert result == {"answer": "Kept [2]. Invalid .", "citations": [{
        "marker": 2, "passageId": "keep", "title": "Kept", "text": "Kept private passage.",
    }], "sources": [{"passageId": "drop", "title": "Dropped", "text": "Dropped private passage."}, {"passageId": "keep", "title": "Kept", "text": "Kept private passage."}]}
    assert [request["op"] for request in seen] == ["capability", "model"]
    assert seen[0]["payload"] == {
        "name": "docs.search@1", "input": {"query": "Which passage?", "mode": "hybrid", "k": 10},
        "effectScope": "dspy/rag/1/0",
    }
    assert "tools" not in seen[-1]["payload"]["options"]
    assert "with its [n] marker, for example [1]." in json.dumps(seen[-1]["payload"]["messages"])


def paused_review():
    seen = []
    transport_for("Must not be requested.", seen)
    executor = create_agent()
    assert asyncio.run(executor.run({"question": "Which passage?", "mode": "hybrid", "review": True}, "review", 5)) is None
    assert [request["op"] for request in seen] == ["capability"]
    pending = executor.pending("review")
    assert pending is not None
    assert pending["value"] == {
        "surfaceId": "rag-review", "component": "rag.ReviewPassages/v1", "viewRevision": "review-v1",
        "props": {"passages": [{"id": p["id"], "title": p["title"]} for p in PASSAGES]},
    }
    return executor, pending


def test_review_restores_and_only_kept_passage_text_reaches_the_model():
    original, pending = paused_review()
    checkpoint, metadata = original._snapshot("review", "session")
    restored = create_agent()
    assert restored._restore(checkpoint, metadata, "session") == "review"
    assert restored.pending("review") == pending
    seen = []
    transport_for("Kept [1]. Invalid [2].", seen)
    result = asyncio.run(restored.run(None, "review", 5, resume={
        "interactionId": pending["id"], "action": "submit", "payload": {"keptIds": ["keep"]},
    }))
    assert result == {"answer": "Kept [1]. Invalid .", "citations": [{
        "marker": 1, "passageId": "keep", "title": "Kept", "text": "Kept private passage.",
    }], "sources": [{"passageId": "keep", "title": "Kept", "text": "Kept private passage."}]}
    assert [request["op"] for request in seen] == ["model"]
    messages = json.dumps(seen[0]["payload"]["messages"])
    assert "Dropped private passage." not in messages
    assert "Kept private passage." in messages


@pytest.mark.parametrize("action,payload", [
    ("approve", {"keptIds": ["keep"]}),
    ("submit", {"keptIds": ["forged"]}),
    ("submit", {"keptIds": ["keep", "keep"]}),
    ("submit", {}),
    ("submit", {"keptIds": ["keep"], "extra": True}),
])
def test_review_resume_rejects_invalid_selection_before_a_model_call(action, payload):
    executor, pending = paused_review()
    seen = []
    transport_for("Must not be requested.", seen)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(executor.run(None, "review", 5, resume={
            "interactionId": pending["id"], "action": action, "payload": payload,
        }))
    assert error.value.code == "invalid"
    assert seen == []
