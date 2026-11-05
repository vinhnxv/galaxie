// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BuiltInAIChatModel } from '../src/builtin-ai/index.js';
import {
  FakeLanguageModel,
  type FakeLanguageModelOptions,
  installLanguageModel,
} from './support/fake-language-model.js';

const languages = { inputLanguages: ['en'], outputLanguages: ['en'] };
let restore = (): void => {};
afterEach(() => {
  restore();
  vi.unstubAllGlobals();
});
function fixture(options: FakeLanguageModelOptions = {}) {
  const fake = new FakeLanguageModel(options);
  restore = installLanguageModel(fake);
  return { fake, model: new BuiltInAIChatModel(languages) };
}

describe('Built-in AI chat model', () => {
  it('imports the subpath without reading the LanguageModel global', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'LanguageModel');
    Object.defineProperty(globalThis, 'LanguageModel', {
      configurable: true,
      get() {
        throw new Error('Import must not probe the model.');
      },
    });
    try {
      vi.resetModules();
      expect((await import('../src/builtin-ai/index.js')).BuiltInAIChatModel).toBeTypeOf(
        'function',
      );
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'LanguageModel');
      else Object.defineProperty(globalThis, 'LanguageModel', original);
    }
  });

  it('maps history, streams non-empty pieces with callbacks, and destroys its session', async () => {
    const { fake, model } = fixture();
    const handleLLMNewToken = vi.fn();
    const chunks = [];
    for await (const chunk of await model.stream(
      [
        new SystemMessage('system'),
        new HumanMessage('one'),
        new AIMessage('two'),
        new HumanMessage('three'),
      ],
      { callbacks: [{ handleLLMNewToken }] },
    ))
      chunks.push(chunk);
    expect(fake.creates).toEqual([
      {
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
        initialPrompts: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'one' },
          { role: 'assistant', content: 'two' },
        ],
      },
    ]);
    expect(fake.sessions[0]?.prompts).toEqual([{ text: 'three', options: {} }]);
    expect(chunks.map((chunk) => chunk.content)).toEqual(['hello ', 'world', '']);
    expect(handleLLMNewToken.mock.calls.map(([text]) => text)).toEqual(['hello ', 'world']);
    expect(chunks.every((chunk) => chunk.usage_metadata === undefined)).toBe(true);
    expect(chunks.at(-1)?.response_metadata).toEqual({ finish_reason: 'stop' });
    expect(fake.sessions[0]?.destroys).toBe(1);
    expect(model.getLsParams()).toEqual({
      ls_provider: 'builtin-ai',
      ls_model_name: 'browser-managed',
      ls_model_type: 'chat',
    });
    expect(model._llmType()).toBe('builtin-ai');
  });

  it('joins invoke text without reporting usage and creates a fresh session each time', async () => {
    const { fake, model } = fixture();
    for (const text of ['one', 'two']) {
      const reply = await model.invoke(text);
      expect(reply.content).toBe('hello world');
      expect(reply.response_metadata).toEqual({ finish_reason: 'stop' });
      expect(reply.usage_metadata).toBeUndefined();
    }
    expect(fake.creates.map((options) => options.initialPrompts)).toEqual([[], []]);
    expect(fake.sessions.map((session) => session.prompts[0]?.text)).toEqual(['one', 'two']);
    expect(fake.sessions.map((session) => session.destroys)).toEqual([1, 1]);
  });

  it('forwards only the schema and signal to the browser, including internal symbol options', async () => {
    const { fake, model } = fixture();
    const jsonSchema = { type: 'object', properties: { answer: { type: 'string' } } };
    const controller = new AbortController();
    const options = {
      jsonSchema,
      signal: controller.signal,
      unknown: 'secret',
      maxTokens: 10,
      temperature: 0.4,
      [Symbol('lease')]: 'secret',
    };
    for await (const _chunk of model._streamResponseChunks([new HumanMessage('hello')], options)) {
      /* drain */
    }
    expect(fake.creates).toEqual([
      {
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
        initialPrompts: [],
        signal: controller.signal,
      },
    ]);
    expect(fake.sessions[0]?.prompts).toEqual([
      {
        text: 'hello',
        options: {
          signal: controller.signal,
          responseConstraint: jsonSchema,
          omitResponseConstraintInput: true,
        },
      },
    ]);
    expect(Reflect.ownKeys(fake.creates[0] ?? {})).toEqual([
      'expectedInputs',
      'expectedOutputs',
      'initialPrompts',
      'signal',
    ]);
    expect(Reflect.ownKeys(fake.sessions[0]?.prompts[0]?.options ?? {})).toEqual([
      'signal',
      'responseConstraint',
      'omitResponseConstraintInput',
    ]);
  });

  it.each([
    [],
    [new HumanMessage('hello'), new SystemMessage('late'), new HumanMessage('hello')],
    [new SystemMessage('one'), new SystemMessage('two'), new HumanMessage('hello')],
    [new AIMessage('last')],
    [
      new AIMessage({ content: '', tool_calls: [{ id: 'tool', name: 'tool', args: {} }] }),
      new HumanMessage('hello'),
    ],
    [
      new AIMessage({
        content: '',
        invalid_tool_calls: [{ name: 'tool', args: 'invalid', error: 'invalid' }],
      }),
      new HumanMessage('hello'),
    ],
    [
      new AIMessage({ content: '', additional_kwargs: { tool_calls: [] } }),
      new HumanMessage('hello'),
    ],
    [
      new AIMessage({
        content: '',
        additional_kwargs: { function_call: { name: 'tool', arguments: '{}' } },
      }),
      new HumanMessage('hello'),
    ],
    [new ToolMessage({ content: 'tool', tool_call_id: 'tool' }), new HumanMessage('hello')],
    [
      new HumanMessage({
        content: [{ type: 'image_url', image_url: 'https://example.test/image' }],
      }),
    ],
  ])('rejects invalid messages before availability or create: %#', async (...messages) => {
    const { fake, model } = fixture();
    await expect(model.invoke(messages)).rejects.toMatchObject({ code: 'invalid' });
    expect(fake.availabilityCalls).toEqual([]);
    expect(fake.creates).toEqual([]);
  });

  it('accepts text blocks and rejects empty language lists', async () => {
    const { fake, model } = fixture();
    await model.invoke([
      new HumanMessage({
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: ' world' },
        ],
      }),
    ]);
    expect(fake.sessions[0]?.prompts[0]?.text).toBe('hello world');
    for (const options of [
      { ...languages, inputLanguages: [] },
      { ...languages, outputLanguages: [] },
      { ...languages, inputLanguages: ['not_a_tag'] },
    ])
      expect(() => new BuiltInAIChatModel(options)).toThrow(
        expect.objectContaining({ code: 'invalid' }),
      );
  });

  it('refuses downloads even with transient activation', async () => {
    const { fake, model } = fixture({ availability: async () => 'downloadable' });
    vi.stubGlobal('navigator', { userActivation: { isActive: true } });
    await expect(model.invoke('hello')).rejects.toMatchObject({
      code: 'unavailable',
      reason: 'download_required',
    });
    expect(fake.creates).toEqual([]);
  });

  it('preserves pre-abort and create-abort reasons without creating a session', async () => {
    const entered = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const { fake, model } = fixture({
      create: async () => {
        entered.resolve();
        await blocked.promise;
      },
    });
    const controller = new AbortController();
    const reason = new Error('host abort');
    const result = model.invoke('hello', { signal: controller.signal });
    const rejected = expect(result).rejects.toBe(reason);
    await entered.promise;
    controller.abort(reason);
    await rejected;
    await expect(model.invoke('hello', { signal: controller.signal })).rejects.toBe(reason);
    expect(fake.creates).toHaveLength(1);
    expect(fake.sessions).toEqual([]);
    blocked.resolve();
  });

  it.each([false, true])(
    'stops after abort and destroys the session (late piece: %s)',
    async (ignoreStreamAbort) => {
      const entered = Promise.withResolvers<void>();
      const blocked = Promise.withResolvers<void>();
      const { fake, model } = fixture({
        ignoreStreamAbort,
        beforeNext: async (index) => {
          if (index === 1) {
            entered.resolve();
            await blocked.promise;
          }
        },
      });
      const controller = new AbortController();
      const reason = new Error('host abort');
      const stream = model._streamResponseChunks([new HumanMessage('hello')], {
        signal: controller.signal,
      });
      expect((await stream.next()).value?.text).toBe('hello ');
      const pending = stream.next();
      const rejected = expect(pending).rejects.toBe(reason);
      await entered.promise;
      controller.abort(reason);
      blocked.resolve();
      await rejected;
      expect((await stream.next()).done).toBe(true);
      expect(fake.sessions[0]?.destroys).toBe(1);
    },
  );

  it.each(['create', 'prompt', 'stream'] as const)(
    'sanitizes browser failures during %s and preserves abort priority',
    async (step) => {
      for (const [name, expected] of [
        [
          'NotSupportedError',
          step === 'create'
            ? { code: 'unavailable', reason: 'unsupported_languages' }
            : { code: 'invalid' },
        ],
        ['QuotaExceededError', { code: 'invalid' }],
        ['TypeError', { code: 'invalid' }],
        ['NetworkError', { code: 'unavailable', reason: 'download_failed' }],
        ['NotAllowedError', { code: 'unavailable', reason: 'not_allowed' }],
        ['SyntaxError', { name: 'ModelProviderError', message: 'The model provider failed.' }],
      ] as const) {
        for (const abort of [false, true]) {
          const controller = new AbortController();
          const reason = new Error('host abort');
          const fail = (): never => {
            if (abort) controller.abort(reason);
            const error = new DOMException('private browser error sentence', name);
            Object.defineProperty(error, 'message', {
              get() {
                throw new Error('Message must not be read.');
              },
            });
            throw error;
          };
          const { fake, model } = fixture(
            step === 'create'
              ? { create: async () => fail() }
              : step === 'prompt'
                ? { prompt: fail }
                : { beforeNext: async () => fail() },
          );
          const caught = await model
            .invoke('private prompt sentence', { signal: controller.signal })
            .catch((error: unknown) => error);
          if (abort) expect(caught).toBe(reason);
          else {
            expect(caught).toMatchObject(expected);
            expect(caught).not.toHaveProperty('cause');
            expect(String(caught)).not.toContain('private');
            expect(JSON.stringify(caught)).not.toContain('private');
          }
          expect(fake.sessions.map((session) => session.destroys)).toEqual(
            step === 'create' ? [] : [1],
          );
          restore();
        }
      }
    },
  );

  it('owns separate sessions for concurrent calls and destroys abandoned streams', async () => {
    const { fake, model } = fixture();
    const replies = await Promise.all([model.invoke('one'), model.invoke('two')]);
    expect(replies.map((reply) => reply.content)).toEqual(['hello world', 'hello world']);
    for await (const _chunk of await model.stream('three')) break;
    expect(fake.sessions).toHaveLength(3);
    expect(fake.sessions.map((session) => session.destroys)).toEqual([1, 1, 1]);
  });
});

describe('Built-in AI structured output', () => {
  const schema = z.object({ answer: z.string() });
  it('parses schema output, supports includeRaw, and uses constrained decoding', async () => {
    const { fake, model } = fixture({ pieces: ['{"answer":"yes"}'] });
    expect(await model.withStructuredOutput(schema).invoke('hello')).toEqual({ answer: 'yes' });
    expect(fake.sessions[0]?.prompts[0]?.options).toMatchObject({
      responseConstraint: { type: 'object', properties: { answer: { type: 'string' } } },
      omitResponseConstraintInput: true,
    });
    const raw = await model.withStructuredOutput(schema, { includeRaw: true }).invoke('hello');
    expect(raw.parsed).toEqual({ answer: 'yes' });
    expect(raw.raw.content).toBe('{"answer":"yes"}');
    expect(() => model.withStructuredOutput(schema, { method: 'functionCalling' })).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
  });

  it('sanitizes parser failures and callbacks while includeRaw returns parsed null', async () => {
    const canary = 'private completion sentence';
    const { model } = fixture({ pieces: [canary] });
    const errors: unknown[] = [];
    const error = await model
      .withStructuredOutput(schema)
      .invoke('hello', {
        callbacks: [
          {
            handleChainError(error) {
              errors.push(error);
            },
          },
        ],
      })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      name: 'ModelProviderError',
      message: 'The model provider failed.',
    });
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(errors.every((error) => !String(error).includes(canary))).toBe(true);
    const raw = await model.withStructuredOutput(schema, { includeRaw: true }).invoke('hello');
    expect(raw.parsed).toBeNull();
    expect(raw.raw.content).toBe(canary);
  });
});
