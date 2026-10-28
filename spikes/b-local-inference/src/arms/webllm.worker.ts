// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type ChatCompletionChunk,
  type ChatCompletionRequestBase,
  WebWorkerMLCEngineHandler,
} from '@mlc-ai/web-llm';

const handler = new WebWorkerMLCEngineHandler();
const generate = handler.engine.chatCompletion.bind(handler.engine);
handler.engine.chatCompletion = (async (request: ChatCompletionRequestBase) => {
  const response = await generate(request);
  const executedIn = self.constructor.name;
  if (Symbol.asyncIterator in response) {
    return (async function* (): AsyncGenerator<ChatCompletionChunk & { executedIn: string }> {
      for await (const chunk of response) yield { ...chunk, executedIn };
    })();
  }
  return { ...response, executedIn };
}) as typeof handler.engine.chatCompletion;
self.onmessage = (event) => handler.onmessage(event);
