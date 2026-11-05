# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from galaxie import GalaxieError, _bridge
from galaxie.langchain import GalaxieChatModel


def test_model_sends_plain_messages_and_returns_checked_usage():
    async def transport(raw):
        message = json.loads(raw)
        assert message["payload"] == {
            "role": "rag.answer",
            "messages": [{"role": "system", "content": "Use data."}, {"role": "user", "content": "Where?"}],
            "options": {},
        }
        return json.dumps({**message, "kind": "response", "ok": True, "payload": {
            "content": "Paris [1].", "usage": {"input_tokens": 12, "output_tokens": 4, "total_tokens": 16}
        }})

    _bridge.install_transport(transport)
    response = asyncio.run(GalaxieChatModel(role="rag.answer").ainvoke([SystemMessage("Use data."), HumanMessage("Where?")]))
    assert isinstance(response, AIMessage)
    assert response.content == "Paris [1]."
    assert response.usage_metadata == {"input_tokens": 12, "output_tokens": 4, "total_tokens": 16}


def test_model_propagates_a_fixed_denial_without_reply_text():
    async def transport(raw):
        message = json.loads(raw)
        return json.dumps({
            "v": message["v"], "kind": "response", "id": message["id"],
            "op": "model", "ok": False,
            "error": {"code": "denied"},
        })

    _bridge.install_transport(transport)
    with pytest.raises(GalaxieError) as error:
        asyncio.run(GalaxieChatModel(role="rag.answer").ainvoke("Where?"))
    assert error.value.code == "denied"
    assert str(error.value) == "Policy denied the request."


def test_stream_yields_checked_deltas_before_the_terminal_reply_and_retains_usage():
    async def exercise():
        release = asyncio.Event()
        async def transport(raw):
            message = json.loads(raw)
            assert message['payload']['options'] == {'stream': True}
            for content in ['first ', 'second']:
                _bridge.receive_model_chunk(json.dumps({
                    'v': _bridge.VERSION, 'kind': 'notify', 'id': message['id'],
                    'op': 'model-chunk', 'payload': {'content': content},
                }))
            await release.wait()
            return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': {
                'content': 'first second', 'usage': {'input_tokens': 2, 'output_tokens': 3, 'total_tokens': 5},
            }})
        _bridge.install_transport(transport)
        stream = GalaxieChatModel(role='answer').astream('question')
        assert (await anext(stream)).content == 'first '
        assert not release.is_set()
        assert (await anext(stream)).content == 'second'
        release.set()
        final = await anext(stream)
        assert final.content == ''
        assert final.usage_metadata == {'input_tokens': 2, 'output_tokens': 3, 'total_tokens': 5}
        assert final.chunk_position == 'last'
        with pytest.raises(StopAsyncIteration):
            await anext(stream)
    asyncio.run(exercise())


def test_closing_a_stream_drains_the_open_call_without_orphaning_checked_deltas():
    async def exercise():
        release = asyncio.Event()
        finished = asyncio.Event()
        async def transport(raw):
            message = json.loads(raw)
            def send(content):
                _bridge.receive_model_chunk(json.dumps({
                    'v': _bridge.VERSION, 'kind': 'notify', 'id': message['id'],
                    'op': 'model-chunk', 'payload': {'content': content},
                }))
            send('first')
            await release.wait()
            send('later')
            finished.set()
            return json.dumps({**message, 'kind': 'response', 'ok': True, 'payload': {'content': 'firstlater'}})
        _bridge.install_transport(transport)
        stream = GalaxieChatModel(role='answer')._astream([HumanMessage('question')])
        assert (await anext(stream)).message.content == 'first'
        closing = asyncio.create_task(stream.aclose())
        await asyncio.sleep(0)
        release.set()
        await closing
        assert finished.is_set()
    asyncio.run(exercise())
