# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import base64
from collections.abc import AsyncIterator
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver, CheckpointTuple, get_checkpoint_metadata, WRITES_IDX_MAP
from langgraph.checkpoint.serde.types import INTERRUPT
from langgraph.types import interrupt

from ._bridge import GalaxieError, request as bridge_request

_checkpointer: BaseCheckpointSaver | None = None


class GalaxieCheckpointer(BaseCheckpointSaver):
    """Serialize in Python; the host's scoped port owns durable byte storage."""

    def _location(self, config):
        configurable = config.get("configurable", {})
        thread = configurable.get("thread_id")
        namespace = configurable.get("checkpoint_ns", "")
        if not isinstance(thread, str) or not thread or not isinstance(namespace, str):
            raise GalaxieError("invalid")
        return {"sessionId": thread, "namespace": namespace}

    def _encode(self, value):
        try:
            kind, data = self.serde.dumps_typed(value)
            return {"type": kind, "bytes": base64.b64encode(data).decode("ascii")}
        except Exception:
            raise GalaxieError("unsupported") from None

    def _decode(self, value):
        try:
            return self.serde.loads_typed((value["type"], base64.b64decode(value["bytes"], validate=True)))
        except Exception:
            raise GalaxieError("unsupported") from None

    def _tuple(self, value):
        config: RunnableConfig = {"configurable": {"thread_id": value["sessionId"], "checkpoint_ns": value["namespace"], "checkpoint_id": value["id"]}}
        parent: RunnableConfig | None = None if value["parentId"] is None else {"configurable": {**config["configurable"], "checkpoint_id": value["parentId"]}}
        return CheckpointTuple(config, self._decode(value["checkpoint"]), self._decode(value["metadata"]), parent,
            [(write["taskId"], write["channel"], self._decode(write["value"])) for write in value["writes"]])

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        payload = {"op": "get", **self._location(config)}
        identifier = config.get("configurable", {}).get("checkpoint_id")
        if identifier:
            payload["id"] = identifier
        value = await bridge_request("checkpoint", payload)
        return None if value is None else self._tuple(value)

    async def alist(self, config: RunnableConfig | None, *, filter=None, before=None, limit=None) -> AsyncIterator[CheckpointTuple]:
        if config is None:
            raise GalaxieError("unsupported")
        payload: dict[str, Any] = {"op": "list", **self._location(config)}
        configurable = config.get("configurable") or {}
        if "checkpoint_ns" not in configurable:
            payload.pop("namespace")
        if configurable.get("checkpoint_id"):
            payload["id"] = configurable["checkpoint_id"]
        if before is not None:
            payload["before"] = (before.get("configurable") or {})["checkpoint_id"]
        # Filtering happens after decoding; a pre-filter limit could hide matches.
        if limit is not None and not filter:
            payload["limit"] = limit
        values = await bridge_request("checkpoint", payload)
        for value in values:
            item = self._tuple(value)
            if filter and not all(item.metadata.get(key) == expected for key, expected in filter.items()):
                continue
            if limit is not None:
                if limit <= 0:
                    break
                limit -= 1
            yield item

    async def aput(self, config: RunnableConfig, checkpoint, metadata, new_versions) -> RunnableConfig:
        location = self._location(config)
        await bridge_request("checkpoint", {"op": "put", **location, "id": checkpoint["id"],
            "parentId": config.get("configurable", {}).get("checkpoint_id"),
            "checkpoint": self._encode(checkpoint), "metadata": self._encode(get_checkpoint_metadata(config, metadata)),
            "timestamp": checkpoint["ts"]})
        return {"configurable": {"thread_id": location["sessionId"], "checkpoint_ns": location["namespace"], "checkpoint_id": checkpoint["id"]}}

    async def aput_writes(self, config: RunnableConfig, writes, task_id: str, task_path: str = "") -> None:
        await bridge_request("checkpoint", {"op": "put-writes", **self._location(config),
            "id": (config.get("configurable") or {})["checkpoint_id"], "taskId": task_id, "taskPath": task_path,
            "writes": [{"channel": channel, "index": WRITES_IDX_MAP.get(channel, index), "value": self._encode(value),
                        "interruptIds": [item.id for item in value] if channel == INTERRUPT else []}
                       for index, (channel, value) in enumerate(writes)]})

    async def adelete_thread(self, thread_id: str) -> None:
        await bridge_request("checkpoint", {"op": "delete", "sessionId": thread_id})


def _install_checkpointer(saver: BaseCheckpointSaver) -> None:
    global _checkpointer
    _checkpointer = saver


def checkpointer() -> BaseCheckpointSaver:
    """Return the saver installed by the Worker before constructing the graph."""
    if _checkpointer is None:
        raise GalaxieError("unavailable")
    return _checkpointer


def request_interaction(request: dict[str, Any], config: RunnableConfig) -> dict[str, Any]:
    """Pause with a four-field request; JavaScript validates its display contract."""
    if (
        not isinstance(request, dict)
        or set(request) != {"surfaceId", "viewRevision", "component", "props"}
        or any(not isinstance(request[key], str) or not request[key]
               for key in ("surfaceId", "viewRevision", "component"))
        or not isinstance(request["props"], dict)
    ):
        raise GalaxieError("invalid")
    # Python's async context carries LangGraph's config across awaits. The explicit
    # argument keeps the authoring contract aligned with other galaxie proxies.
    answer = interrupt(request)
    if (not isinstance(answer, dict) or set(answer) != {"action", "payload"}
            or not isinstance(answer["action"], str) or not answer["action"]):
        raise GalaxieError("invalid")
    return {"action": answer["action"], "payload": answer["payload"]}
