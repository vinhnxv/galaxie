# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import itertools
import base64
import json
from collections.abc import Awaitable, Callable
from typing import Any

VERSION = "galaxie.bridge/v2"
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
    if op not in ("model", "capability", "checkpoint"):
        raise GalaxieError("invalid")
    if op == "checkpoint" and not _checkpoint_request(payload):
        raise GalaxieError("invalid")
    if _transport is None:
        raise GalaxieError("unavailable")
    identifier = str(next(_ids))
    message = {"v": VERSION, "kind": "request", "id": identifier, "op": op, "payload": payload}
    try:
        raw = json.dumps(message, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        if len(raw.encode("utf-8")) > MAX_BYTES:
            raise GalaxieError("unsupported")
    except (ValueError, TypeError, UnicodeError):
        raise GalaxieError("invalid") from None
    try:
        reply = await _transport(raw)
    except GalaxieError:
        raise
    except Exception:
        raise GalaxieError("unavailable") from None
    try:
        if not isinstance(reply, str):
            raise GalaxieError("invalid")
        if len(reply.encode("utf-8")) > MAX_BYTES:
            raise GalaxieError("unsupported")
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
                or set(value["error"]) != {"code"}
                or value["error"].get("code") not in ERROR_MESSAGES
            ):
                raise GalaxieError("invalid")
            raise GalaxieError(value["error"]["code"])
        if value.get("ok") is not True or set(value) != {
            "v", "kind", "id", "op", "ok", "payload"
        }:
            raise GalaxieError("invalid")
        if op == "checkpoint":
            reply = value["payload"]
            operation = payload["op"]
            valid = (reply is None or _checkpoint_tuple(reply)) if operation == "get" else (
                isinstance(reply, list) and all(_checkpoint_tuple(item) for item in reply)
                if operation == "list" else reply is None)
            if not valid:
                raise GalaxieError("invalid")
        return value["payload"]
    except (ValueError, TypeError, UnicodeError):
        raise GalaxieError("invalid") from None


def _text(value):
    return isinstance(value, str) and bool(value)


def _binary(value):
    if not isinstance(value, dict) or set(value) != {"type", "bytes"} or not _text(value["type"]) or not isinstance(value["bytes"], str):
        return False
    try:
        return base64.b64encode(base64.b64decode(value["bytes"], validate=True)).decode("ascii") == value["bytes"]
    except (ValueError, TypeError):
        return False


def _checkpoint_request(value):
    if not isinstance(value, dict) or not _text(value.get("sessionId")):
        return False
    op = value.get("op")
    location = {"op", "sessionId", "namespace"}
    if op == "delete":
        return set(value) == {"op", "sessionId"}
    if op == "list":
        return ({"op", "sessionId"} <= set(value) <= location | {"id", "before", "limit"}
                and ("namespace" not in value or isinstance(value["namespace"], str))
                and ("id" not in value or _text(value["id"]))
                and ("before" not in value or _text(value["before"]))
                and ("limit" not in value or type(value["limit"]) is int and value["limit"] >= 0))
    if not isinstance(value.get("namespace"), str):
        return False
    if op == "get":
        return location <= set(value) <= location | {"id"} and ("id" not in value or _text(value["id"]))
    if not _text(value.get("id")):
        return False
    if op == "put":
        return (set(value) == location | {"id", "parentId", "checkpoint", "metadata", "timestamp"}
                and (value["parentId"] is None or _text(value["parentId"]))
                and _binary(value["checkpoint"]) and _binary(value["metadata"]) and _text(value["timestamp"]))
    if op == "put-writes":
        return (set(value) == location | {"id", "taskId", "taskPath", "writes"}
                and _text(value["taskId"]) and isinstance(value["taskPath"], str)
                and isinstance(value["writes"], list) and all(
                    isinstance(write, dict) and set(write) == {"channel", "index", "value", "interruptIds"}
                    and isinstance(write["channel"], str) and type(write["index"]) is int and _binary(write["value"])
                    and isinstance(write["interruptIds"], list) and all(_text(item) for item in write["interruptIds"])
                    and (write["channel"] == "__interrupt__" or not write["interruptIds"])
                    for write in value["writes"]))
    return False


def _checkpoint_tuple(value):
    return (isinstance(value, dict) and set(value) == {"sessionId", "namespace", "id", "parentId", "checkpoint", "metadata", "writes", "parentWrites"}
            and _text(value["sessionId"]) and isinstance(value["namespace"], str) and _text(value["id"])
            and (value["parentId"] is None or _text(value["parentId"]))
            and _binary(value["checkpoint"]) and _binary(value["metadata"])
            and all(isinstance(value[key], list) and all(
                isinstance(write, dict) and set(write) == {"taskId", "channel", "value", "taskPath", "index"}
                and _text(write["taskId"]) and isinstance(write["channel"], str) and _binary(write["value"])
                and isinstance(write["taskPath"], str) and type(write["index"]) is int
                for write in value[key]) for key in ("writes", "parentWrites")))
