# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json
from pathlib import Path

from galaxie._bridge import install_transport
from rag_agent.graph import create_agent


def test_cpython_matches_the_shared_behavioral_transcript(monkeypatch):
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "false")
    directory = Path(__file__).resolve().parents[2] / "test" / "golden"
    script = json.loads((directory / "script.json").read_text())
    expected = json.loads((directory / "session.json").read_text())
    transcript = []

    async def transport(raw):
        request = json.loads(raw)
        payload = request["payload"]
        if request["op"] == "capability":
            assert payload["name"] == "docs.search@1"
            transcript.append({
                "type": "capability", "name": payload["name"], "input": payload["input"]
            })
            item = next(item for item in script["session"] if payload["input"] == {
                "query": item["input"]["question"], "mode": item["input"]["mode"], "k": 10
            })
            reply = item["search"]
        else:
            assert request["op"] == "model"
            transcript.append({
                "type": "model", "role": payload["role"], "messages": payload["messages"]
            })
            item = next(
                item for item in script["session"]
                if payload["messages"] == item["model"]["messages"]
            )
            assert payload["role"] == item["model"]["role"]
            reply = {"content": item["model"]["reply"]}
        return json.dumps({
            "v": request["v"], "kind": "response", "id": request["id"],
            "op": request["op"], "ok": True, "payload": reply,
        })

    async def run():
        install_transport(transport)
        graph = create_agent()
        for item in script["session"]:
            output = await graph.ainvoke(item["input"])
            transcript.append({"type": "output", "output": output})

    asyncio.run(run())
    assert transcript == expected
