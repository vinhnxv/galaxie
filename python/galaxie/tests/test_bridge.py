# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

import asyncio
import json

import pytest

from galaxie import GalaxieError
from galaxie import _bridge, capabilities


async def unused_transport(_: str) -> str:
    raise AssertionError("The transport is not used.")


def test_capability_forwards_input_and_full_effect_scope():
    recorded = []

    async def transport(raw):
        message = json.loads(raw)
        recorded.append(message)
        return json.dumps({**message, "kind": "response", "ok": True, "payload": {"value": 42}})

    _bridge.install_transport(transport)
    config = {"metadata": {"langgraph_checkpoint_ns": "parent:task|child:task"}}
    assert asyncio.run(capabilities.call("math.double@1", {"value": 21}, config)) == {"value": 42}
    assert recorded[0]["payload"] == {
        "name": "math.double@1", "input": {"value": 21}, "effectScope": "parent:task|child:task"
    }
    assert recorded[0]["v"] == "galaxie.bridge/v2"
    assert recorded[0]["op"] == "capability"


def test_capability_accepts_explicit_checkpoint_namespace():
    async def transport(raw):
        message = json.loads(raw)
        assert message["payload"]["effectScope"] == "explicit:task"
        return json.dumps({**message, "kind": "response", "ok": True, "payload": None})

    _bridge.install_transport(transport)
    assert asyncio.run(capabilities.call("read@1", {}, {"configurable": {"checkpoint_ns": "explicit:task"}})) is None


@pytest.mark.parametrize("response", ["not JSON", "[]"])
def test_malformed_reply_has_fixed_invalid_error(response):
    async def transport(_):
        return response

    _bridge.install_transport(transport)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(capabilities.call("read@1", {}))
    assert error.value.code == "invalid"
    assert str(error.value) == "The request is invalid."


@pytest.mark.parametrize("field,value", [("v", "galaxie.bridge/v1"), ("op", "unknown"), ("kind", "notify")])
def test_reply_rejects_unknown_version_or_operation(field, value):
    async def transport(raw):
        message = json.loads(raw)
        response = {**message, "kind": "response", "ok": True, "payload": None}
        response[field] = value
        return json.dumps(response)

    _bridge.install_transport(transport)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(capabilities.call("read@1", {}))
    assert error.value.code == "invalid"
    assert str(error.value) == "The request is invalid."


def test_error_rejects_extra_remote_text():
    async def transport(raw):
        message = json.loads(raw)
        return json.dumps({"v": message["v"], "kind": "response", "id": message["id"], "op": message["op"], "ok": False, "error": {"code": "denied", "message": "PRIVATE REPLY"}})

    _bridge.install_transport(transport)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(capabilities.call("read@1", {}))
    assert error.value.code == "invalid"
    assert str(error.value) == "The request is invalid."


def test_unknown_outgoing_operation_is_rejected():
    with pytest.raises(GalaxieError, match="^The request is invalid\\.$"):
        asyncio.run(_bridge.request("unknown", {}))


def test_oversized_reply_is_unsupported():
    async def transport(_):
        return "é" * 524289

    _bridge.install_transport(transport)
    with pytest.raises(GalaxieError, match="^This operation is unsupported\\.$"):
        asyncio.run(capabilities.call("read@1", {}))


def test_standin_round_trips_the_supported_msgpack_values():
    import msgpack
    import ormsgpack

    for value in [{"nested": [1, None, True, {"bytes": b"abc"}]}, ["text", 3.5], ormsgpack.Ext(7, b"body")]:
        packed = ormsgpack.packb(value)
        assert packed == msgpack.packb(value, use_bin_type=True)
        assert ormsgpack.unpackb(packed) == value


def test_standin_supplies_the_langgraph_serializer_import_surface():
    from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

    serializer = JsonPlusSerializer()
    value = {"nested": [1, True, None], "bytes": b"body"}
    assert serializer.loads_typed(serializer.dumps_typed(value)) == value


def test_stream_projection_is_closed_and_limits_metadata():
    from langchain_core.messages import AIMessageChunk
    from langgraph.types import Interrupt

    notifications = []
    _bridge.install_transport(unused_transport, notifications.append)
    _bridge.notify_stream(('node:task',), 'messages', (
        AIMessageChunk(id='reply', content='checked', response_metadata={'private': 'OMIT'}),
        {'langgraph_node': 'node', 'langgraph_checkpoint_ns': 'node:task', 'private': 'OMIT'},
    ))
    assert json.loads(notifications[-1])['payload'] == [
        ['node:task'], 'messages', [
            {'type': 'AIMessageChunk', 'content': 'checked', 'id': 'reply'},
            {'langgraph_node': 'node', 'langgraph_checkpoint_ns': 'node:task'},
        ],
    ]
    assert 'OMIT' not in notifications[-1]
    _bridge.notify_stream((), 'updates', {'__interrupt__': (Interrupt(id='one', value={'question': 'Continue?'}),)})
    assert json.loads(notifications[-1])['payload'][2] == {
        '__interrupt__': [{'id': 'one', 'value': {'question': 'Continue?'}}],
    }


@pytest.mark.parametrize('data', [b'PRIVATE', {1: 'PRIVATE'}, float('nan'), object(), 'é' * 524289])
def test_unsupported_stream_data_never_leaves_python(data):
    notifications = []
    _bridge.install_transport(unused_transport, notifications.append)
    with pytest.raises(GalaxieError, match='^This operation is unsupported\\.$'):
        _bridge.notify_stream((), 'custom', data)
    assert notifications == []


def test_unsolicited_model_chunk_is_rejected():
    with pytest.raises(GalaxieError, match='^The request is invalid\\.$'):
        _bridge.receive_model_chunk(json.dumps({
            'v': _bridge.VERSION, 'kind': 'notify', 'op': 'model-chunk',
            'id': 'missing', 'payload': {'content': 'PRIVATE'},
        }))
