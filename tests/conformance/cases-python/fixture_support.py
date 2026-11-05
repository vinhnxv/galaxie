# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import re
from typing import Any, TypedDict

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langgraph.types import interrupt

REQUEST = {
    "surfaceId": "main", "viewRevision": "r1", "component": "conformance.Question/v1",
    "props": {"question": "Continue?"},
}


class ValueState(TypedDict):
    value: int
    answer: Any
    counts: dict[str, int]


class FixtureModelError(Exception):
    pass


class ScriptedModel(BaseChatModel):
    script: dict[str, Any]

    @property
    def _llm_type(self):
        return "galaxie-fixture"

    def _reply(self, messages):
        human = next((message for message in reversed(messages) if message.type == "human"), None)
        entry = self.script.get(human.text) if human is not None else None
        if entry is None:
            raise FixtureModelError("The fixture has no script for this human message.")
        if "error" in entry:
            raise FixtureModelError("The conformance fixture failed.")
        return entry

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        entry = self._reply(messages)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(
            id=entry["id"], content=entry["text"], usage_metadata=entry["usage"],
        ))])

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        return self._generate(messages, stop, **kwargs)

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        entry = self._reply(messages)
        words = re.findall(r"\S+\s*", entry["text"]) or [""]
        for index, word in enumerate(words):
            yield ChatGenerationChunk(message=AIMessageChunk(
                id=entry["id"], content=word,
                usage_metadata=entry["usage"] if index == len(words) - 1 else None,
            ))


def model_or_default(model, script):
    return model if model is not None else ScriptedModel(script=script)


def native_interaction(request, config):
    return interrupt(request)


async def native_capability(name, value, config):
    if name != "double@1":
        raise ValueError("The native fixture capability is missing.")
    return {"value": value["value"] * 2}
