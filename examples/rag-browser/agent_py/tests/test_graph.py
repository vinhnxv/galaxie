# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json

from galaxie._bridge import install_transport

from rag_agent.graph import create_agent
from rag_agent.prompt import system_prompt, user_prompt


def test_graph_uses_host_proxies_and_projects_its_output(monkeypatch):
    monkeypatch.setattr("rag_agent.graph.checkpointer", lambda: None)
    passages = [{"id": "france", "title": "France", "text": "Paris is the capital.", "score": 1}]
    requests = []

    async def transport(raw):
        request = json.loads(raw)
        requests.append(request)
        if request["op"] == "capability":
            payload = {"passages": passages}
        else:
            payload = {"content": "Paris [1]. [11]"}
        return json.dumps({
            "v": request["v"], "kind": "response", "id": request["id"],
            "op": request["op"], "ok": True, "payload": payload,
        })

    install_transport(transport)
    result = asyncio.run(create_agent().ainvoke({"question": "capital of France", "mode": "hybrid"}))
    assert result == {
        "answer": "Paris [1]. ",
        "citations": [{"marker": 1, "passageId": "france", "title": "France", "text": "Paris is the capital."}],
    }
    assert [request["op"] for request in requests] == ["capability", "model"]
    assert requests[0]["payload"]["name"] == "docs.search@1"
    assert requests[0]["payload"]["input"] == {"query": "capital of France", "mode": "hybrid", "k": 10}
    assert requests[0]["payload"]["effectScope"].startswith("retrieve:")
    assert requests[1]["payload"] == {
        "role": "rag.answer",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt("capital of France", passages)},
        ],
        "options": {},
    }
