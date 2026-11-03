// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ModelProviderError } from '../src/errors.js';
import { TransformersChatModel } from '../src/transformers/chat-model.js';
import { createTransformersEngine } from '../src/transformers/engine.js';
import type { FakeRuntimeOptions } from './support/fake-transformers-runtime.js';
import { setup } from './support/transformers-loopback.js';

async function fixture(runtime: FakeRuntimeOptions = {}) {
  const parts = await setup({ runtime });
  const handle = await createTransformersEngine(
    { worker: parts.worker, model: parts.model.record, allowDownload: true },
    { gpu: undefined },
  );
  return { ...parts, handle, model: new TransformersChatModel(handle) };
}

describe('Transformers chat model', () => {
  it('streams deltas in order and reports usage and finish reason on the final chunk only', async () => {
    const { runtime, handle, model } = await fixture({ pieces: ['one ', 'two ', 'three'] });
    const handleLLMNewToken = vi.fn();
    try {
      const chunks = [];
      for await (const chunk of await model.stream(
        [new SystemMessage('system'), new HumanMessage('hello')],
        { callbacks: [{ handleLLMNewToken }] },
      ))
        chunks.push(chunk);
      expect(chunks.map((chunk) => chunk.content).join('')).toBe('one two three');
      expect(handleLLMNewToken.mock.calls.map((call) => call[0])).toEqual([
        'one ',
        'two ',
        'three',
      ]);
      expect(chunks.filter((chunk) => chunk.usage_metadata !== undefined)).toEqual([chunks.at(-1)]);
      expect(chunks.at(-1)?.usage_metadata).toEqual({
        input_tokens: 5,
        output_tokens: 3,
        total_tokens: 8,
      });
      expect(chunks.at(-1)?.response_metadata).toEqual({ finish_reason: 'stop' });
      expect(runtime.generations[0]?.request.messages).toEqual([
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
      ]);
      expect(model.getLsParams()).toMatchObject({
        ls_provider: 'transformers',
        ls_model_name: handle.modelId,
      });
    } finally {
      await handle.dispose();
    }
  });

  it('invoke joins the same stream with usage and finish reason', async () => {
    const { handle, model } = await fixture({ pieces: ['one ', 'two ', 'three'] });
    try {
      const reply = await model.invoke([
        new HumanMessage('hi'),
        new AIMessage('hello'),
        new HumanMessage('again'),
      ]);
      expect(reply.content).toBe('one two three');
      expect(reply.usage_metadata).toEqual({ input_tokens: 5, output_tokens: 3, total_tokens: 8 });
      expect(reply.response_metadata).toMatchObject({ finish_reason: 'stop' });
    } finally {
      await handle.dispose();
    }
  });

  it('defaults to 1024 tokens at temperature 0 and whitelists per-call overrides', async () => {
    const { runtime, handle } = await fixture();
    try {
      const model = new TransformersChatModel(handle);
      await model.invoke('hello');
      expect(runtime.generations[0]?.request).toMatchObject({ maxTokens: 1024, temperature: 0 });
      const configured = new TransformersChatModel(handle, { maxTokens: 128, temperature: 0.2 });
      await configured.invoke('hello');
      expect(runtime.generations[1]?.request).toMatchObject({ maxTokens: 128, temperature: 0.2 });
      await configured.invoke('hello', {
        maxTokens: 64,
        temperature: 0.7,
        secret: 'canary',
        [Symbol('lease')]: 'canary',
      } as never);
      const request = runtime.generations[2]?.request;
      expect(request).toEqual({
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 64,
        temperature: 0.7,
      });
      expect(Reflect.ownKeys(request ?? {}).every((key) => typeof key === 'string')).toBe(true);
    } finally {
      await handle.dispose();
    }
  });

  it.each([
    [],
    [new HumanMessage('hello'), new SystemMessage('late'), new HumanMessage('hello')],
    [new SystemMessage('first'), new SystemMessage('second'), new HumanMessage('hello')],
    [new AIMessage('last')],
    [
      new AIMessage({ content: '', tool_calls: [{ id: 'tool', name: 'tool', args: {} }] }),
      new HumanMessage('hello'),
    ],
    [new ToolMessage({ content: 'tool', tool_call_id: 'tool' }), new HumanMessage('hello')],
    [
      new HumanMessage({
        content: [{ type: 'image_url', image_url: 'https://example.test/image' }],
      }),
    ],
  ])('rejects unsupported message input before dispatch: %#', async (...messages) => {
    const { runtime, worker, handle, model } = await fixture();
    try {
      await expect(model.invoke(messages)).rejects.toMatchObject({ code: 'invalid' });
      expect(runtime.generations).toEqual([]);
      expect(
        worker.toWorker.filter((message) => (message as { type: string }).type === 'generate'),
      ).toEqual([]);
    } finally {
      await handle.dispose();
    }
  });

  it('stops at an abort with its reason and leaves the handle usable', async () => {
    const { runtime, handle, model } = await fixture({ holdAfter: 1 });
    const controller = new AbortController();
    const reason = new Error('host abort');
    const received: string[] = [];
    try {
      const stream = await model.stream('hello', { signal: controller.signal });
      const consumed = (async () => {
        for await (const chunk of stream) {
          if (typeof chunk.content === 'string' && chunk.content) received.push(chunk.content);
          if (received.length === 1) controller.abort(reason);
        }
      })();
      await expect(consumed).rejects.toBe(reason);
      expect(received).toEqual(['Hello']);
      // The aborted turn is released only after the Worker answers, so the next call runs after it.
      const next = await model.invoke('again');
      expect(next.content).toBe('Hello world');
      expect(runtime.generations).toHaveLength(2);
    } finally {
      await handle.dispose();
    }
  });

  it('fails invalid before any chunk when prompt and maxTokens exceed the context window', async () => {
    const { handle, model } = await fixture({ promptTokens: 2000 });
    try {
      const received: unknown[] = [];
      const consumed = (async () => {
        for await (const chunk of await model.stream('hello', { maxTokens: 100 }))
          received.push(chunk);
      })();
      await expect(consumed).rejects.toMatchObject({ code: 'invalid' });
      expect(received).toEqual([]);
      // The handle still serves a request that fits.
      expect((await model.invoke('hello', { maxTokens: 10 })).content).toBe('Hello world');
    } finally {
      await handle.dispose();
    }
  });

  it('sends a schema call option to the runtime and returns the parsed object', async () => {
    const answer = z.object({ answer: z.string() });
    const { runtime, handle, model } = await fixture({ pieces: ['{"answer":', '"yes"}'] });
    try {
      const parsed = await model.withStructuredOutput(answer).invoke('hello');
      expect(parsed).toEqual({ answer: 'yes' });
      expect(runtime.generations[0]?.request.jsonSchema).toEqual(toJsonSchema(answer));
      const raw = await model.withStructuredOutput(answer, { includeRaw: true }).invoke('hello');
      expect(raw.parsed).toEqual({ answer: 'yes' });
      expect(raw.raw.content).toBe('{"answer":"yes"}');
    } finally {
      await handle.dispose();
    }
  });

  it('fails with the fixed provider error, without the reply text, when the reply does not match', async () => {
    const { handle, model } = await fixture({ pieces: ['{"answer":"private canary"'] });
    try {
      const failure: unknown = await model
        .withStructuredOutput(z.object({ answer: z.string() }))
        .invoke('hello')
        .catch((error: unknown) => error);
      // The router maps this fixed error to `invalid` (conformance); the model adds no reply text.
      expect(failure).toBeInstanceOf(ModelProviderError);
      expect(String((failure as Error).message)).not.toContain('canary');
    } finally {
      await handle.dispose();
    }
  });

  it.each([
    ['a non-object schema', 'text'],
    ['an array schema', ['x']],
  ])('fails invalid before any dispatch for %s', async (_label, schema) => {
    const { runtime, handle, model } = await fixture();
    try {
      await expect(
        model.invoke('hello', { jsonSchema: schema as unknown as Record<string, unknown> }),
      ).rejects.toMatchObject({ code: 'invalid' });
      expect(runtime.generations).toEqual([]);
    } finally {
      await handle.dispose();
    }
  });

  it('rejects another structured-output method as unsupported', async () => {
    const { handle, model } = await fixture();
    try {
      expect(() =>
        model.withStructuredOutput(z.object({ a: z.string() }), { method: 'functionCalling' }),
      ).toThrow(expect.objectContaining({ code: 'unsupported' }));
    } finally {
      await handle.dispose();
    }
  });
});
