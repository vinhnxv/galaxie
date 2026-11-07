// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import { createStructuredDecisionModel } from '../src/decision/structured.js';
import { WebLLMChatModel } from '../src/webllm/chat-model.js';
import { createWebLLMEngine } from '../src/webllm/engine.js';
import { decisionRequest, decisionSchema } from './support/decision-request.js';
import { createFakeWebLLM, FakeWebLLMStream } from './support/fake-webllm.js';

test('the complete decision enum schema reaches WebLLM response_format unchanged', async () => {
  const fake = createFakeWebLLM({
    create: async () =>
      new FakeWebLLMStream([
        {
          choices: [
            { delta: { content: '{"ask":true,"route":"ask","score":0}' }, finish_reason: 'stop' },
          ],
        },
      ]),
  });
  const handle = await createWebLLMEngine(
    { worker: fake.worker },
    { gpu: fake.gpu, loadModule: async () => fake.module },
  );
  try {
    const chat = new WebLLMChatModel(handle);
    const config = vi.spyOn(chat, 'invoke');
    const result = await createStructuredDecisionModel(chat).decide(decisionRequest, {
      signal: new AbortController().signal,
      maxTokens: 64,
    });
    expect(config).toHaveBeenCalledExactlyOnceWith(
      expect.any(Array),
      expect.objectContaining({ jsonSchema: decisionSchema }),
    );
    expect(fake.engine.requests).toHaveLength(1);
    expect(fake.engine.requests[0]?.response_format).toEqual({
      type: 'json_object',
      schema: JSON.stringify(decisionSchema),
    });
    expect(result.answers).toEqual({
      ask: { value: true },
      route: { value: 'ask' },
      score: { value: 0 },
    });
    expect(fake.constructions).toBe(1);
    fake.engine.assertClosed();
  } finally {
    await handle.dispose();
  }
});
