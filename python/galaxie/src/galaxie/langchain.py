# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from ._bridge import GalaxieError, request


class GalaxieChatModel(BaseChatModel):
    """Text-only model proxy. Routing, credentials and safety stay in JavaScript."""

    role: str

    @property
    def _llm_type(self) -> str:
        return "galaxie"

    def _generate(
        self, messages: list[BaseMessage], stop: list[str] | None = None,
        run_manager=None, **kwargs: Any,
    ) -> ChatResult:
        raise GalaxieError("unsupported")

    async def _agenerate(
        self, messages: list[BaseMessage], stop: list[str] | None = None,
        run_manager=None, **kwargs: Any,
    ) -> ChatResult:
        roles = {"system": "system", "human": "user", "ai": "assistant"}
        converted = []
        for message in messages:
            role = roles.get(message.type)
            if (
                role is None or not isinstance(message.content, str)
                or getattr(message, "tool_calls", None)
            ):
                raise GalaxieError("unsupported")
            converted.append({"role": role, "content": message.content})
        options = {} if stop is None else {"stop": stop}
        reply = await request("model", {"role": self.role, "messages": converted, "options": options})
        if (
            not isinstance(reply, dict)
            or not isinstance(reply.get("content"), str)
            or not set(reply) <= {"content", "usage"}
        ):
            raise GalaxieError("invalid")
        usage = reply.get("usage")
        if usage is not None and (
            not isinstance(usage, dict)
            or set(usage) != {"input_tokens", "output_tokens", "total_tokens"}
            or any(type(value) is not int or value < 0 for value in usage.values())
            or usage["input_tokens"] + usage["output_tokens"] != usage["total_tokens"]
        ):
            raise GalaxieError("invalid")
        message = AIMessage(content=reply["content"], usage_metadata=usage)
        return ChatResult(generations=[ChatGeneration(message=message)])
