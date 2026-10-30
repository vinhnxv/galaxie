# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.types import interrupt

from ._bridge import GalaxieError

_checkpointer: BaseCheckpointSaver | None = None


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
