// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { WebLLMChatModel } from '../src/webllm/chat-model.js';
import { createWebLLMEngine } from '../src/webllm/engine.js';
import {
  createFakeWebLLM,
  type FakeWebLLMOptions,
  FakeWebLLMStream,
} from './support/fake-webllm.js';

async function fixture(options: FakeWebLLMOptions = {}) {
  const fake = createFakeWebLLM(options);
  const handle = await createWebLLMEngine(
    { worker: fake.worker },
    { gpu: fake.gpu, loadModule: async () => fake.module },
  );
  return { fake, handle, model: new WebLLMChatModel(handle) };
}

describe('WebLLM chat model', () => {
  it('maps full text history, streams deltas and reports usage only on the final chunk', async () => {
    const { fake, handle, model } = await fixture();
    const handleLLMNewToken = vi.fn();
    const messages = [
      new SystemMessage('system'),
      new HumanMessage('one'),
      new AIMessage('two'),
      new HumanMessage('three'),
    ];
    try {
      const chunks = [];
      for await (const chunk of await model.stream(messages, {
        callbacks: [{ handleLLMNewToken }],
      }))
        chunks.push(chunk);
      expect(chunks.map((chunk) => chunk.content).join('')).toBe('hello world');
      expect(handleLLMNewToken.mock.calls.map((call) => call[0])).toEqual(['hello ', 'world']);
      expect(chunks.filter((chunk) => chunk.usage_metadata !== undefined)).toEqual([chunks.at(-1)]);
      expect(chunks.at(-1)?.usage_metadata).toEqual({
        input_tokens: 12,
        output_tokens: 5,
        total_tokens: 17,
      });
      expect(chunks.at(-1)?.response_metadata).toEqual({ finish_reason: 'stop' });
      expect(fake.engine.requests).toEqual([
        {
          messages: [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'one' },
            { role: 'assistant', content: 'two' },
            { role: 'user', content: 'three' },
          ],
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 1024,
          temperature: 0,
        },
      ]);
      expect(model.getLsParams()).toMatchObject({
        ls_provider: 'webllm',
        ls_model_name: handle.modelId,
      });
      fake.engine.assertClosed();
    } finally {
      await handle.dispose();
    }
  });

  it('invoke joins the same stream with usage and finish reason', async () => {
    const { fake, handle, model } = await fixture();
    try {
      const reply = await model.invoke('hello');
      expect(reply.content).toBe('hello world');
      expect(reply.usage_metadata).toEqual({
        input_tokens: 12,
        output_tokens: 5,
        total_tokens: 17,
      });
      expect(reply.response_metadata).toMatchObject({ finish_reason: 'stop' });
      fake.engine.assertClosed();
    } finally {
      await handle.dispose();
    }
  });

  it('whitelists call options, with per-model defaults and per-call overrides', async () => {
    const { fake, handle } = await fixture();
    try {
      const model = new WebLLMChatModel(handle, { maxTokens: 128, temperature: 0.2 });
      await model.invoke('hello');
      expect(fake.engine.requests[0]).toMatchObject({ max_tokens: 128, temperature: 0.2 });
      const schema = { type: 'object', properties: { answer: { type: 'string' } } };
      const options = {
        maxTokens: 64,
        temperature: 0.7,
        jsonSchema: schema,
        secret: 'canary',
        [Symbol('lease')]: 'canary',
      };
      await model.invoke('hello', options);
      expect(fake.engine.requests[1]).toEqual({
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 64,
        temperature: 0.7,
        response_format: { type: 'json_object', schema: JSON.stringify(schema) },
      });
      expect(
        Reflect.ownKeys(fake.engine.requests[1] ?? {}).every((key) => typeof key === 'string'),
      ).toBe(true);
      fake.engine.assertClosed();
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
  ])('rejects unsupported message input before engine dispatch: %#', async (...messages) => {
    const { fake, handle, model } = await fixture();
    try {
      await expect(model.invoke(messages)).rejects.toMatchObject({ code: 'invalid' });
      expect(fake.engine.requests).toEqual([]);
      expect(fake.engine.resets).toBe(0);
    } finally {
      await handle.dispose();
    }
  });

  it('preserves an invoke abort reason and closes the engine without usage', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const reason = new Error('host abort');
    const { fake, handle, model } = await fixture({
      create: async () =>
        new FakeWebLLMStream(undefined, {
          beforeNext: async (index) => {
            if (index === 1) {
              entered.resolve();
              await release.promise;
            }
          },
        }),
    });
    try {
      const result = model.invoke('hello', { signal: controller.signal });
      const rejected = expect(result).rejects.toBe(reason);
      await entered.promise;
      controller.abort(reason);
      await rejected;
      expect(fake.engine.interrupts).toBe(1);
      fake.engine.assertClosed();
    } finally {
      release.resolve();
      await handle.dispose();
    }
  });
});

describe('WebLLM structured output', () => {
  const schema = z.object({ answer: z.string() });
  const json = '{"answer":"yes"}';
  const reply = (text: string): FakeWebLLMOptions => ({
    create: async () =>
      new FakeWebLLMStream([
        { choices: [{ delta: { content: text }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } },
      ]),
  });

  it('parses Zod output, binds schema decoding, and supports includeRaw', async () => {
    const { fake, handle, model } = await fixture(reply(json));
    try {
      expect(await model.withStructuredOutput(schema).invoke('hello')).toEqual({ answer: 'yes' });
      const responseFormat = fake.engine.requests[0]?.response_format;
      expect(responseFormat?.type).toBe('json_object');
      expect(JSON.parse(responseFormat?.schema ?? '{}')).toMatchObject({
        type: 'object',
        properties: { answer: { type: 'string' } },
      });
      const raw = await model.withStructuredOutput(schema, { includeRaw: true }).invoke('hello');
      expect(raw.parsed).toEqual({ answer: 'yes' });
      expect(raw.raw.content).toBe(json);
      expect(() => model.withStructuredOutput(schema, { method: 'functionCalling' })).toThrow(
        expect.objectContaining({ code: 'unsupported' }),
      );
      fake.engine.assertClosed();
    } finally {
      await handle.dispose();
    }
  });

  it('accepts Standard Schema and plain JSON Schema values', async () => {
    const { fake, handle, model } = await fixture(reply(json));
    try {
      const standard = { '~standard': schema['~standard'] };
      expect(await model.withStructuredOutput(standard).invoke('hello')).toEqual({ answer: 'yes' });
      const jsonSchema = { type: 'object', properties: { answer: { type: 'string' } } };
      expect(await model.withStructuredOutput(jsonSchema).invoke('hello')).toEqual({
        answer: 'yes',
      });
      fake.engine.assertClosed();
    } finally {
      await handle.dispose();
    }
  });

  it('drops parser text and causes while includeRaw falls back to parsed null', async () => {
    const canary = 'private completion canary';
    const { fake, handle, model } = await fixture(reply(canary));
    try {
      const errors: unknown[] = [];
      let error: unknown;
      try {
        await model.withStructuredOutput(schema).invoke('hello', {
          callbacks: [
            {
              handleChainError(caught) {
                errors.push(caught);
              },
            },
          ],
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        name: 'ModelProviderError',
        message: 'The model provider failed.',
      });
      expect(error).not.toHaveProperty('cause');
      expect(JSON.stringify(error)).not.toContain(canary);
      expect(errors.every((caught) => !String(caught).includes(canary))).toBe(true);
      const result = await model.withStructuredOutput(schema, { includeRaw: true }).invoke('hello');
      expect(result.parsed).toBeNull();
      expect(result.raw.content).toBe(canary);
      fake.engine.assertClosed();
    } finally {
      await handle.dispose();
    }
  });
});
