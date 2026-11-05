# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
from collections.abc import AsyncGenerator
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

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

    def _payload(self, messages: list[BaseMessage], stop: list[str] | None) -> dict[str, Any]:
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
        return {"role": self.role, "messages": converted, "options": options}

    @staticmethod
    def _message(reply: Any) -> AIMessage:
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
        return AIMessage(content=reply["content"], usage_metadata=usage)

    async def _agenerate(
        self, messages: list[BaseMessage], stop: list[str] | None = None,
        run_manager=None, **kwargs: Any,
    ) -> ChatResult:
        reply = await request('model', self._payload(messages, stop))
        return ChatResult(generations=[ChatGeneration(message=self._message(reply))])

    async def _astream(
        self, messages: list[BaseMessage], stop: list[str] | None = None,
        run_manager=None, **kwargs: Any,
    ) -> AsyncGenerator[ChatGenerationChunk, None]:
        payload = self._payload(messages, stop)
        payload['options']['stream'] = True
        chunks: asyncio.Queue[str | None] = asyncio.Queue()
        task = asyncio.create_task(request('model', payload, on_chunk=chunks.put_nowait))
        task.add_done_callback(lambda _: chunks.put_nowait(None))
        content = ''
        try:
            while (delta := await chunks.get()) is not None:
                content += delta
                yield ChatGenerationChunk(message=AIMessageChunk(content=delta))
            reply = self._message(await task)
            if reply.content != content:
                raise GalaxieError('invalid')
            yield ChatGenerationChunk(message=AIMessageChunk(
                content='', usage_metadata=reply.usage_metadata, chunk_position='last',
            ))
        except asyncio.CancelledError:
            task.cancel()
            raise
        finally:
            await asyncio.gather(task, return_exceptions=True)
