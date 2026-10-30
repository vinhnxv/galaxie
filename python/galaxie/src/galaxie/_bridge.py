# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import itertools
import json
from collections.abc import Awaitable, Callable
from typing import Any

VERSION = "galaxie.bridge/v1"
MAX_BYTES = 1_048_576
ERROR_MESSAGES = {
    "invalid": "The request is invalid.",
    "denied": "Policy denied the request.",
    "unavailable": "The requested service is unavailable.",
    "unreachable": (
        "The endpoint did not answer. Local Network Access may be denied, "
        "CORS may not allow this app origin (for example OLLAMA_ORIGINS), "
        "or the server may be stopped."
    ),
    "unsupported": "This operation is unsupported.",
    "budget_exceeded": "The budget limit was reached.",
    "timeout": "The operation timed out.",
    "stale": "The request targets stale state.",
    "duplicate": "The submission was already accepted.",
    "fenced": "Another owner controls the runtime.",
    "cancelled": "The operation was cancelled.",
    "unrecoverable": "Stored state cannot be recovered.",
    "outcome_unknown": "The outcome of an earlier call is unknown.",
    "executor_error": "The executor or agent code failed.",
}


class GalaxieError(Exception):
    def __init__(self, code: str):
        self.code = code if code in ERROR_MESSAGES else "invalid"
        super().__init__(ERROR_MESSAGES[self.code])


_transport: Callable[[str], Awaitable[str]] | None = None
_ids = itertools.count(1)


def install_transport(transport: Callable[[str], Awaitable[str]]) -> None:
    global _transport
    if not callable(transport):
        raise GalaxieError("invalid")
    _transport = transport


def _invalid_constant(_: str) -> None:
    raise GalaxieError("invalid")


async def request(op: str, payload: dict[str, Any]) -> Any:
    if op not in ("model", "capability"):
        raise GalaxieError("invalid")
    if _transport is None:
        raise GalaxieError("unavailable")
    identifier = str(next(_ids))
    message = {"v": VERSION, "kind": "request", "id": identifier, "op": op, "payload": payload}
    try:
        raw = json.dumps(message, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        if len(raw.encode("utf-8")) > MAX_BYTES:
            raise GalaxieError("invalid")
    except (ValueError, TypeError, UnicodeError):
        raise GalaxieError("invalid") from None
    try:
        reply = await _transport(raw)
    except GalaxieError:
        raise
    except Exception:
        raise GalaxieError("unavailable") from None
    try:
        if not isinstance(reply, str) or len(reply.encode("utf-8")) > MAX_BYTES:
            raise GalaxieError("invalid")
        value = json.loads(reply, parse_constant=_invalid_constant)
        if (
            not isinstance(value, dict)
            or value.get("v") != VERSION
            or value.get("kind") != "response"
            or value.get("id") != identifier
            or value.get("op") != op
        ):
            raise GalaxieError("invalid")
        if value.get("ok") is False:
            if (
                set(value) != {"v", "kind", "id", "op", "ok", "error"}
                or not isinstance(value["error"], dict)
                or value["error"].get("code") not in ERROR_MESSAGES
            ):
                raise GalaxieError("invalid")
            raise GalaxieError(value["error"]["code"])
        if value.get("ok") is not True or set(value) != {
            "v", "kind", "id", "op", "ok", "payload"
        }:
            raise GalaxieError("invalid")
        return value["payload"]
    except (ValueError, TypeError, UnicodeError):
        raise GalaxieError("invalid") from None
