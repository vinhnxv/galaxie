# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import empty_checkpoint

from galaxie._bridge import install_transport
from galaxie.langgraph import GalaxieCheckpointer


def test_checkpoint_bytes_reconstruct_with_a_fresh_saver():
    requests = []

    async def transport(raw):
        message = json.loads(raw)
        requests.append(message["payload"])
        payload = None
        if message["payload"]["op"] == "get":
            put, writes = requests[:2]
            payload = {key: put[key] for key in ("sessionId", "namespace", "id", "parentId", "checkpoint", "metadata")}
            payload.update(writes=[{**writes["writes"][0], "taskId": writes["taskId"], "taskPath": writes["taskPath"]}], parentWrites=[])
            payload["writes"][0].pop("interruptIds")
        return json.dumps({"v": message["v"], "kind": "response", "id": message["id"], "op": "checkpoint", "ok": True, "payload": payload})

    async def run():
        install_transport(transport)
        saver = GalaxieCheckpointer()
        checkpoint = empty_checkpoint()
        checkpoint["channel_values"] = {"text": "café", "bytes": b"\x00\xff", "tuple": (1, 2)}
        config: RunnableConfig = {"configurable": {"thread_id": "session", "checkpoint_ns": ""}}
        saved = await saver.aput(config, checkpoint, {"source": "loop", "step": 0, "parents": {}}, {})
        await saver.aput_writes(saved, [("answer", False)], "task", "parent")
        restored = await GalaxieCheckpointer().aget_tuple(config)
        assert restored is not None
        assert restored.checkpoint["channel_values"] == {"text": "café", "bytes": b"\x00\xff", "tuple": [1, 2]}
        assert restored.pending_writes == [("task", "answer", False)]
        assert restored.metadata == {"source": "loop", "step": 0, "parents": {}}
        assert restored.config == saved

    asyncio.run(run())
