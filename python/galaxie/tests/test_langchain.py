# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

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
