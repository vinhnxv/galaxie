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
_notify: Callable[[str], None] | None = None
_streams: dict[str, Callable[[dict[str, Any]], None]] = {}
_ids = itertools.count(1)


def install_transport(
    transport: Callable[[str], Awaitable[str]], notify: Callable[[str], None] | None = None,
) -> None:
    global _transport, _notify
    if not callable(transport) or (notify is not None and not callable(notify)):
        raise GalaxieError("invalid")
    _transport = transport
    _notify = notify


def _invalid_constant(_: str) -> None:
    raise GalaxieError("invalid")


def _keys(value, required, optional=()):
    return isinstance(value, dict) and set(required) <= value.keys() <= set(required) | set(optional)


def _tool_call(value):
    return (
        _keys(value, ('id', 'type', 'function')) and _text(value['id'])
        and len(value['id']) <= 128 and value['type'] == 'function'
        and _keys(value['function'], ('name', 'arguments'))
        and _text(value['function']['name']) and isinstance(value['function']['arguments'], str)
    )


def _tool_definition(value):
    return (
        _keys(value, ('type', 'function')) and value['type'] == 'function'
        and _keys(value['function'], ('name', 'parameters'), ('description', 'strict'))
        and _text(value['function']['name']) and isinstance(value['function']['parameters'], dict)
        and ('description' not in value['function'] or isinstance(value['function']['description'], str))
        and ('strict' not in value['function'] or type(value['function']['strict']) is bool)
    )


def _model_message(value):
    if not isinstance(value, dict) or not isinstance(value.get('content'), str):
        return False
    role = value.get('role')
    if role == 'tool':
        return _keys(value, ('role', 'content', 'tool_call_id')) and _text(value['tool_call_id'])
    if role == 'assistant':
        return _keys(value, ('role', 'content'), ('toolCalls',)) and (
            'toolCalls' not in value or isinstance(value['toolCalls'], list)
            and all(_tool_call(call) for call in value['toolCalls'])
        )
    return role in ('system', 'user') and _keys(value, ('role', 'content'))


def _model_request(value):
    if not (
        _keys(value, ('role', 'messages', 'options')) and _text(value['role'])
        and isinstance(value['messages'], list) and all(_model_message(message) for message in value['messages'])
        and _keys(value['options'], (), ('stop', 'stream', 'tools', 'toolChoice'))
    ):
        return False
    options = value['options']
    if 'stop' in options and not (isinstance(options['stop'], (list, tuple)) and all(isinstance(item, str) for item in options['stop'])):
        return False
    if 'stream' in options and type(options['stream']) is not bool:
        return False
    if 'tools' in options and not (isinstance(options['tools'], list) and all(_tool_definition(item) for item in options['tools'])):
        return False
    if 'toolChoice' in options:
        choice = options['toolChoice']
        if choice not in ('auto', 'none', 'required') and not (
            _keys(choice, ('type', 'function')) and choice['type'] == 'function'
            and _keys(choice['function'], ('name',)) and _text(choice['function']['name'])
        ):
            return False
    return True


def _model_reply(value):
    if not (_keys(value, ('content',), ('usage', 'toolCalls')) and isinstance(value['content'], str)):
        return False
    if 'toolCalls' in value and not (isinstance(value['toolCalls'], list) and all(_tool_call(item) for item in value['toolCalls'])):
        return False
    if 'usage' in value:
        usage = value['usage']
        if not (_keys(usage, ('input_tokens', 'output_tokens', 'total_tokens')) and all(type(item) is int and item >= 0 for item in usage.values()) and usage['input_tokens'] + usage['output_tokens'] == usage['total_tokens']):
            return False
    return True


def _model_chunk(value):
    if not (_keys(value, ('content',), ('toolCalls',)) and isinstance(value['content'], str)):
        return False
    if 'toolCalls' not in value:
        return True
    if not isinstance(value['toolCalls'], list):
        return False
    for call in value['toolCalls']:
        if not (
            _keys(call, ('index', 'function'), ('id', 'type'))
            and type(call['index']) is int and call['index'] >= 0
            and ('id' not in call or _text(call['id']))
            and ('type' not in call or call['type'] == 'function')
            and _keys(call['function'], (), ('name', 'arguments'))
            and all(isinstance(item, str) for item in call['function'].values())
        ):
            return False
    return True


async def request(
    op: str, payload: dict[str, Any], *, on_chunk: Callable[[str], None] | None = None,
    on_model_chunk: Callable[[dict[str, Any]], None] | None = None,
) -> Any:
    if op not in ("model", "capability", "checkpoint"):
        raise GalaxieError("invalid")
    if op == "checkpoint" and not _checkpoint_request(payload):
        raise GalaxieError("invalid")
    if op == 'model' and not _model_request(payload):
        raise GalaxieError('invalid')
    if _transport is None:
        raise GalaxieError("unavailable")
    callback = on_model_chunk if on_model_chunk is not None else (
        (lambda chunk: on_chunk(chunk['content'])) if on_chunk is not None else None
    )
    if (on_chunk is not None and on_model_chunk is not None) or (callback is not None and (
        not callable(on_model_chunk or on_chunk) or op != 'model' or payload.get('options', {}).get('stream') is not True
    )):
        raise GalaxieError('invalid')
    identifier = str(next(_ids))
    message = {"v": VERSION, "kind": "request", "id": identifier, "op": op, "payload": payload}
    try:
        raw = json.dumps(message, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        if len(raw.encode("utf-8")) > MAX_BYTES:
            raise GalaxieError("unsupported")
    except (ValueError, TypeError, UnicodeError):
        raise GalaxieError("invalid") from None
    try:
        if callback is not None:
            _streams[identifier] = callback
        reply = await _transport(raw)
    except GalaxieError:
        raise
    except Exception:
        raise GalaxieError("unavailable") from None
    finally:
        _streams.pop(identifier, None)
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
        if op == 'model' and not _model_reply(value['payload']):
            raise GalaxieError('invalid')
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


def receive_model_chunk(raw: str) -> None:
    try:
        if not isinstance(raw, str):
            raise GalaxieError('invalid')
        if len(raw.encode('utf-8')) > MAX_BYTES:
            raise GalaxieError('unsupported')
        message = json.loads(raw, parse_constant=_invalid_constant)
        if (
            not isinstance(message, dict) or set(message) != {'v', 'kind', 'id', 'op', 'payload'}
            or message['v'] != VERSION or message['kind'] != 'notify'
            or message['op'] != 'model-chunk' or not isinstance(message['id'], str)
            or message['id'] not in _streams or not isinstance(message['payload'], dict)
            or not _model_chunk(message['payload'])
        ):
            raise GalaxieError('invalid')
        _streams[message['id']](message['payload'])
    except (ValueError, TypeError, UnicodeError):
        raise GalaxieError('invalid') from None


def _project_stream(value: Any) -> Any:
    if isinstance(value, (list, tuple)):
        return [_project_stream(item) for item in value]
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise GalaxieError('unsupported')
        return {key: _project_stream(item) for key, item in value.items()}
    if value is None or type(value) in (str, bool, int, float):
        return value
    from langchain_core.messages import BaseMessage
    from langgraph.types import Interrupt

    if isinstance(value, Interrupt):
        return {'id': value.id, 'value': _project_stream(value.value)}
    if isinstance(value, BaseMessage):
        return {'type': value.type, 'content': _project_stream(value.content), 'id': value.id}
    raise GalaxieError('unsupported')


def notify_stream(path, mode, data) -> None:
    if _notify is None:
        raise GalaxieError('unavailable')
    try:
        if not isinstance(path, (list, tuple)) or any(not isinstance(item, str) for item in path):
            raise GalaxieError('unsupported')
        if mode not in ('values', 'updates', 'messages', 'custom'):
            raise GalaxieError('unsupported')
        if mode == 'messages':
            message, metadata = data
            data = [message, {key: metadata[key] for key in (
                'langgraph_node', 'langgraph_checkpoint_ns',
            ) if key in metadata}]
        raw = json.dumps({
            'v': VERSION, 'kind': 'notify', 'id': str(next(_ids)), 'op': 'stream',
            'payload': [list(path), mode, _project_stream(data)],
        }, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
        if len(raw.encode('utf-8')) > MAX_BYTES:
            raise GalaxieError('unsupported')
        _notify(raw)
    except GalaxieError:
        raise
    except Exception:
        raise GalaxieError('unsupported') from None


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
