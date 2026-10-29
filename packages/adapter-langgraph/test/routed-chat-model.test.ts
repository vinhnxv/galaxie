// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  GalaxieError,
  type ModelCall,
  type ModelPort,
  type ModelUsage,
  toErrorInfo,
} from '@galaxie/core';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  type StandardMessageStructure,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { BuiltInAIChatModel } from '../../models/src/builtin-ai/chat-model.js';
import { MockChatModel } from '../../models/src/mock.js';
import { WebLLMChatModel } from '../../models/src/webllm/chat-model.js';
import { createWebLLMEngine } from '../../models/src/webllm/engine.js';
import {
  FakeLanguageModel,
  installLanguageModel,
} from '../../models/test/support/fake-language-model.js';
import { createFakeWebLLM, FakeWebLLMStream } from '../../models/test/support/fake-webllm.js';
import { RoutedChatModel } from '../src/routed-chat-model.js';
import { LangGraphTraceHandler } from '../src/trace-handler.js';

class OptionProbeModel extends BaseChatModel {
  readonly observed: unknown[] = [];
  readonly #key: symbol;
  constructor(key: symbol) {
    super({});
    this.#key = key;
  }
  override _llmType(): string {
    return 'option-probe';
  }
  override async _generate(
    _messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    this.observed.push(Reflect.get(options, this.#key));
    return {
      generations: [{ text: 'ok', message: new AIMessage<StandardMessageStructure>('ok') }],
    };
  }
  override async *_streamResponseChunks(
    _messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): AsyncGenerator<ChatGenerationChunk> {
    this.observed.push(Reflect.get(options, this.#key));
    yield new ChatGenerationChunk({
      text: 'ok',
      message: new AIMessageChunk<StandardMessageStructure>('ok'),
    });
  }
}

test('symbol call-option keys survive LangChain 1.2.20 generate and stream option separation', async () => {
  const key = Symbol('lease-probe');
  const token = Object.freeze({});
  const model = new OptionProbeModel(key);
  const options = { stop: [], [key]: token };
  await model.invoke('hello', options);
  for await (const _chunk of model._streamIterator('hello', options)) {
    /* drain */
  }
  expect(model.observed).toEqual([token, token]);
});

test('public stream normalizes away caller symbols before the routing injection point', async () => {
  const key = Symbol('outer-probe');
  const model = new OptionProbeModel(key);
  for await (const _chunk of await model.stream('hello', {
    stop: [],
    [key]: Object.freeze({}),
  } as typeof model.ParsedCallOptions)) {
    /* drain */
  }
  expect(model.observed).toEqual([undefined]);
});

class StartObserver extends BaseCallbackHandler {
  override name: string = 'start-observer';
  readonly starts: { metadata: Record<string, unknown> | undefined; options: unknown }[] = [];
  override handleChatModelStart(
    _llm: unknown,
    _messages: BaseMessage[][],
    _runId: string,
    _parentRunId?: string,
    extra?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    this.starts.push({ metadata, options: extra?.['options'] });
  }
}
function routed(
  provider: BaseChatModel = new MockChatModel({
    hello: {
      id: 'reply',
      text: 'hello world',
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    },
  }),
  repairAttempts = 0,
) {
  const end = vi.fn<(usage?: ModelUsage) => void>();
  const fail = vi.fn<() => void>();
  const lease: ModelCall = {
    providerId: 'provider',
    destination: 'in-browser',
    end,
    fail,
    outputSafetyOutcome: 'unset',
    checkOutput: async () => {},
  };
  const begin = vi.fn<ModelPort['begin']>(async (_role, options) => {
    if ((options?.repairAttempt ?? 0) > repairAttempts)
      throw new GalaxieError('invalid', toErrorInfo('invalid').message);
    return lease;
  });
  const handler = new LangGraphTraceHandler({
    recordsText: false,
    start: () => ({ end: () => {} }),
  });
  return {
    model: new RoutedChatModel('assistant', { provider }, () => ({ models: { begin }, handler })),
    begin,
    end,
    fail,
    provider,
    handler,
  };
}

test('Built-in AI streaming settles without usage so core charges the reservation', async () => {
  const fake = new FakeLanguageModel();
  const restore = installLanguageModel(fake);
  const fixture = routed(
    new BuiltInAIChatModel({ inputLanguages: ['en'], outputLanguages: ['en'] }),
  );
  try {
    const chunks = [];
    for await (const chunk of await fixture.model.stream('hello')) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.content).join('')).toBe('hello world');
    expect(fixture.end).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(fixture.fail).not.toHaveBeenCalled();
    expect(fake.sessions[0]?.destroys).toBe(1);
  } finally {
    restore();
  }
});

test('WebLLM streaming settles reported usage exactly once through the routed model', async () => {
  const fake = createFakeWebLLM();
  const handle = await createWebLLMEngine(
    { worker: fake.worker },
    { gpu: fake.gpu, loadModule: async () => fake.module },
  );
  const fixture = routed(new WebLLMChatModel(handle));
  try {
    const chunks = [];
    for await (const chunk of await fixture.model.stream('hello')) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.content).join('')).toBe('hello world');
    expect(fixture.end).toHaveBeenCalledExactlyOnceWith({ inputTokens: 12, outputTokens: 5 });
    expect(fixture.fail).not.toHaveBeenCalled();
    fake.engine.assertClosed();
  } finally {
    await handle.dispose();
  }
});

test('WebLLM cancellation fails the routed lease without settling partial usage', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fake = createFakeWebLLM({
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
  const handle = await createWebLLMEngine(
    { worker: fake.worker },
    { gpu: fake.gpu, loadModule: async () => fake.module },
  );
  const fixture = routed(new WebLLMChatModel(handle));
  const controller = new AbortController();
  const reason = new Error('host cancellation');
  try {
    const stream = await fixture.model.stream('hello', { signal: controller.signal });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.content).toBe('hello ');
    const pending = iterator.next();
    const rejected = expect(pending).rejects.toBe(reason);
    await entered.promise;
    controller.abort(reason);
    await rejected;
    expect(fixture.fail).toHaveBeenCalledTimes(1);
    expect(fixture.end).not.toHaveBeenCalled();
    expect(fake.engine.interrupts).toBe(1);
    fake.engine.assertClosed();
  } finally {
    release.resolve();
    await handle.dispose();
  }
});

test('invoke routes once and emits one LangChain model run with selected provider metadata', async () => {
  const fixture = routed(
    new MockChatModel(
      {
        hello: {
          id: 'reply',
          text: 'hello world',
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        },
      },
      { provider: 'sample-provider', model: 'sample-model' },
    ),
  );
  const observer = new StartObserver();
  expect((await fixture.model.invoke('hello', { callbacks: [observer] })).content).toBe(
    'hello world',
  );
  expect(fixture.begin).toHaveBeenCalledTimes(1);
  expect(observer.starts).toHaveLength(1);
  expect(observer.starts[0]?.metadata).toMatchObject({
    ls_provider: 'sample-provider',
    ls_model_name: 'sample-model',
  });
  expect(fixture.end).toHaveBeenCalledExactlyOnceWith({ inputTokens: 2, outputTokens: 3 });
  expect(fixture.fail).not.toHaveBeenCalled();
});

test('stream routes once and legacy streamEvents routes without a pre-existing lease', async () => {
  const streamed = routed();
  const chunks = [];
  for await (const chunk of await streamed.model.stream('hello')) chunks.push(chunk.content);
  expect(chunks).toEqual(['hello ', 'world']);
  expect(streamed.begin).toHaveBeenCalledTimes(1);
  expect(streamed.end).toHaveBeenCalledExactlyOnceWith({ inputTokens: 2, outputTokens: 3 });
  const legacy = routed();
  const events = [];
  for await (const event of legacy.model.streamEvents('hello')) events.push(event);
  expect(events.length).toBeGreaterThan(0);
  expect(legacy.begin).toHaveBeenCalledTimes(1);
  expect(legacy.end).toHaveBeenCalledExactlyOnceWith({ inputTokens: 2, outputTokens: 3 });
  expect(legacy.fail).not.toHaveBeenCalled();
});

test('versioned streamEvents also routes one call', async () => {
  const fixture = routed();
  const events = [];
  for await (const event of fixture.model.streamEvents('hello', { version: 'v2' }))
    events.push(event.event);
  expect(events).toContain('on_chat_model_start');
  expect(events).toContain('on_chat_model_end');
  expect(fixture.begin).toHaveBeenCalledTimes(1);
  expect(fixture.end).toHaveBeenCalledExactlyOnceWith({ inputTokens: 2, outputTokens: 3 });
});

test('LangGraph messages streams receive each provider token once', async () => {
  const fixture = routed();
  const state = Annotation.Root({ answer: Annotation<string> });
  const graph = new StateGraph(state)
    .addNode('respond', async (_state, config) => ({
      answer: (await fixture.model.invoke('hello', config)).content as string,
    }))
    .addEdge(START, 'respond')
    .addEdge('respond', END)
    .compile();
  const chunks = [];
  for await (const [chunk] of await graph.stream({}, { streamMode: 'messages' }))
    chunks.push(chunk.content);
  expect(chunks).toEqual(['hello ', 'world']);
  expect(fixture.begin).toHaveBeenCalledTimes(1);
  expect(fixture.end).toHaveBeenCalledTimes(1);
});

test('multi-list generate rejects before routing while batch reserves each input', async () => {
  const fixture = routed();
  await expect(
    fixture.model.generate([[new HumanMessage('hello')], [new HumanMessage('hello')]]),
  ).rejects.toMatchObject({ code: 'unsupported' });
  expect(fixture.begin).not.toHaveBeenCalled();
  expect((fixture.provider as MockChatModel).calls).toBe(0);
  expect((await fixture.model.batch(['hello', 'hello'])).map((reply) => reply.content)).toEqual([
    'hello world',
    'hello world',
  ]);
  expect(fixture.begin).toHaveBeenCalledTimes(2);
  expect(fixture.end).toHaveBeenCalledTimes(2);
});

test('a consumed lease token rejects reuse before another provider dispatch', async () => {
  const fixture = routed();
  const observer = new StartObserver();
  await fixture.model.invoke('hello', { callbacks: [observer] });
  const reused = observer.starts[0]?.options as typeof fixture.model.ParsedCallOptions;
  await expect(fixture.model._generate([new HumanMessage('hello')], reused)).rejects.toMatchObject({
    code: 'invalid',
  });
  expect(fixture.begin).toHaveBeenCalledTimes(1);
  expect((fixture.provider as MockChatModel).calls).toBe(1);
  expect(fixture.end).toHaveBeenCalledTimes(1);
});

test('breaking a public stream after its first chunk fails the lease once', async () => {
  const fixture = routed(new MockChatModel({ hello: { id: 'reply', text: 'one two three four' } }));
  for await (const chunk of await fixture.model.stream('hello')) {
    expect(chunk.content).toBe('one ');
    break;
  }
  expect(fixture.fail).toHaveBeenCalledTimes(1);
  expect(fixture.end).not.toHaveBeenCalled();
  expect((fixture.provider as MockChatModel).calls).toBe(1);
});

class SplitUsageModel extends BaseChatModel {
  constructor() {
    super({});
  }
  override _llmType(): string {
    return 'split-usage';
  }
  override async _generate(): Promise<ChatResult> {
    throw new Error('must stream');
  }
  override async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
    yield new ChatGenerationChunk({
      text: 'one ',
      message: new AIMessageChunk<StandardMessageStructure>({
        content: 'one ',
        usage_metadata: { input_tokens: 2, output_tokens: 0, total_tokens: 2 },
      }),
    });
    yield new ChatGenerationChunk({
      text: 'two',
      message: new AIMessageChunk<StandardMessageStructure>({
        content: 'two',
        usage_metadata: { input_tokens: 0, output_tokens: 3, total_tokens: 3 },
      }),
    });
  }
}
test('stream settlement adds usage from the first and last chunks', async () => {
  const fixture = routed(new SplitUsageModel());
  const chunks = [];
  for await (const chunk of await fixture.model.stream('hello')) chunks.push(chunk.content);
  expect(chunks).toEqual(['one ', 'two']);
  expect(fixture.end).toHaveBeenCalledExactlyOnceWith({ inputTokens: 2, outputTokens: 3 });
});

class GenerateOnlyModel extends BaseChatModel {
  calls = 0;
  constructor() {
    super({});
  }
  override _llmType(): string {
    return 'generate-only';
  }
  override async _generate(): Promise<ChatResult> {
    this.calls++;
    return {
      generations: [
        {
          text: 'whole reply',
          message: new AIMessage<StandardMessageStructure>({
            id: 'whole',
            content: 'whole reply',
            usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          }),
        },
      ],
    };
  }
}
test('a generate-only provider streams as one chunk with usage', async () => {
  const provider = new GenerateOnlyModel();
  const fixture = routed(provider);
  const chunks = [];
  for await (const chunk of await fixture.model.stream('hello')) chunks.push(chunk);
  expect(chunks.map((chunk) => ({ content: chunk.content, id: chunk.id }))).toEqual([
    { content: 'whole reply', id: 'whole' },
  ]);
  expect(provider.calls).toBe(1);
  expect(fixture.end).toHaveBeenCalledExactlyOnceWith({ inputTokens: 1, outputTokens: 2 });
});

test.each(['invoke', 'stream'] as const)(
  'provider %s errors reach the caller as the same object and fail the lease',
  async (mode) => {
    const raw = new Error('provider failure');
    const fixture = routed(new MockChatModel({ hello: { error: raw } }));
    if (mode === 'invoke') await expect(fixture.model.invoke('hello')).rejects.toBe(raw);
    else await expect(fixture.model.stream('hello')).rejects.toBe(raw);
    expect(fixture.fail).toHaveBeenCalledTimes(1);
    expect(fixture.end).not.toHaveBeenCalled();
  },
);

test('credential factories receive the per-call credential while callbacks only receive opaque options', async () => {
  const credential = 'canary-credential-5e1d';
  const end = vi.fn();
  const fail = vi.fn();
  const begin = vi.fn(
    async (): Promise<ModelCall> => ({
      providerId: 'remote',
      destination: 'host-server',
      credential,
      outputSafetyOutcome: 'unset',
      checkOutput: async () => {},
      end,
      fail,
    }),
  );
  const provider = new MockChatModel({ hello: { id: 'reply', text: 'ok' } });
  const factory = vi.fn(({ credential: received }: { readonly credential: string }) => {
    expect(received).toBe(credential);
    return provider;
  });
  const handler = new LangGraphTraceHandler({
    recordsText: false,
    start: () => ({ end: () => {} }),
  });
  const model = new RoutedChatModel('assistant', { remote: factory }, () => ({
    models: { begin },
    handler,
  }));
  const observer = new StartObserver();
  await model.invoke('hello', { callbacks: [observer] });
  await model.invoke('hello', { callbacks: [observer] });
  expect(factory).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(observer.starts)).not.toContain(credential);
  for (const start of observer.starts) {
    const options = start.options as object;
    for (const key of Reflect.ownKeys(options))
      expect(Reflect.get(options, key)).not.toBe(credential);
  }
  expect(end).toHaveBeenCalledTimes(2);
  expect(fail).not.toHaveBeenCalled();
});

test('calls outside an active run reject invalid', async () => {
  const model = new RoutedChatModel('assistant', {}, () => undefined);
  await expect(model.invoke('hello')).rejects.toMatchObject({ code: 'invalid' });
});

test('a provider with disableStreaming uses generation even through routed stream', async () => {
  const provider = new MockChatModel({ hello: { id: 'reply', text: 'hello world' } });
  provider.disableStreaming = true;
  const generate = vi.spyOn(provider, '_generate');
  const stream = vi.spyOn(provider, '_streamResponseChunks');
  const fixture = routed(provider);
  const chunks = [];
  for await (const chunk of await fixture.model.stream('hello')) chunks.push(chunk.content);
  expect(chunks).toEqual(['hello world']);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(stream).not.toHaveBeenCalled();
  expect(fixture.end).toHaveBeenCalledTimes(1);
});

class StructuredReplyModel extends BaseChatModel {
  readonly schemas: unknown[] = [];
  readonly reply: AIMessage<StandardMessageStructure>;
  constructor(content: string | Array<{ type: 'text'; text: string }>) {
    super({});
    this.reply = new AIMessage<StandardMessageStructure>({ content });
  }
  override _llmType(): string {
    return 'structured-reply';
  }
  override async _generate(
    _messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    this.schemas.push(Reflect.get(options, 'jsonSchema'));
    return {
      generations: [
        {
          text: typeof this.reply.content === 'string' ? this.reply.content : '',
          message: this.reply,
        },
      ],
    };
  }
}

const answerSchema = z.object({ answer: z.literal('yes') });
test('structured repair forwards the original messages, invalid reply and fixed instruction through routing', async () => {
  const instruction =
    'The previous reply did not match the required JSON Schema. Reply again with only JSON that matches the schema.';
  const provider = new MockChatModel({
    hello: { id: 'invalid', text: 'invalid-reply-canary' },
    [instruction]: { id: 'valid', text: '{"answer":"yes"}' },
  });
  const generate = vi.spyOn(provider, '_generate');
  const fixture = routed(provider, 1);
  const messages = [new HumanMessage('hello')];
  expect(await fixture.model.withStructuredOutput(answerSchema).invoke(messages)).toEqual({
    answer: 'yes',
  });
  expect(provider.calls).toBe(2);
  expect(generate.mock.calls[1]?.[0].map((message) => [message.type, message.content])).toEqual([
    ['human', 'hello'],
    ['ai', 'invalid-reply-canary'],
    ['human', instruction],
  ]);
  expect(messages).toHaveLength(1);
  expect(fixture.begin).toHaveBeenNthCalledWith(2, 'assistant', {
    requires: ['structured-output'],
    repairAttempt: 1,
  });
  expect(generate.mock.calls.map(([, options]) => Reflect.get(options, 'jsonSchema'))).toEqual([
    toJsonSchema(answerSchema),
    toJsonSchema(answerSchema),
  ]);
  expect(fixture.end).toHaveBeenCalledTimes(2);
});
test.each(['zod', 'standard', 'json'] as const)(
  'routed structured output validates %s schemas and forwards constrained decoding',
  async (kind) => {
    const provider = new StructuredReplyModel('{"answer":"yes"}');
    const fixture = routed(provider);
    const schema =
      kind === 'zod'
        ? answerSchema
        : kind === 'standard'
          ? { '~standard': answerSchema['~standard'] }
          : toJsonSchema(answerSchema);
    expect(await fixture.model.withStructuredOutput(schema).invoke('hello')).toEqual({
      answer: 'yes',
    });
    expect(provider.schemas).toEqual([toJsonSchema(schema)]);
    expect(fixture.begin).toHaveBeenCalledExactlyOnceWith('assistant', {
      requires: ['structured-output'],
    });
    expect(fixture.end).toHaveBeenCalledTimes(1);
    expect(fixture.fail).not.toHaveBeenCalled();
  },
);

test('includeRaw returns the message and parsed value', async () => {
  const provider = new StructuredReplyModel('{"answer":"yes"}');
  const fixture = routed(provider);
  const result = await fixture.model
    .withStructuredOutput(answerSchema, { includeRaw: true })
    .invoke('hello');
  expect(result.raw.content).toBe(provider.reply.content);
  expect(result.parsed).toEqual({ answer: 'yes' });
});

test.each([
  'not json canary',
  '{"answer":"private-reply-canary"}',
  [{ type: 'text' as const, text: '{"answer":"yes"}' }],
])(
  'structured output rejects invalid reply %# with fixed errors and normal settlement',
  async (content) => {
    const fixture = routed(new StructuredReplyModel(content));
    const observed: Error[] = [];
    const waiting = fixture.model.withStructuredOutput(answerSchema).invoke('hello', {
      callbacks: [
        {
          handleChainError: (error) => {
            observed.push(error);
          },
        },
      ],
    });
    await expect(waiting).rejects.toMatchObject({
      code: 'invalid',
      message: toErrorInfo('invalid').message,
    });
    const error = await waiting.catch((error: unknown) => error);
    expect(error).not.toHaveProperty('cause');
    for (const item of observed) {
      expect(item.message).toBe(toErrorInfo('invalid').message);
      expect(item).not.toHaveProperty('cause');
    }
    expect(fixture.end).toHaveBeenCalledTimes(1);
    expect(fixture.fail).not.toHaveBeenCalled();
    const withRaw = await fixture.model
      .withStructuredOutput(answerSchema, { includeRaw: true })
      .invoke('hello');
    expect(withRaw.raw.content).toEqual(content);
    expect(withRaw.parsed).toBeNull();
    expect(fixture.end).toHaveBeenCalledTimes(2);
    expect(fixture.fail).not.toHaveBeenCalled();
  },
);

test('structured output rejects unsupported methods and unconvertible schemas before routing', () => {
  const fixture = routed();
  expect(() =>
    fixture.model.withStructuredOutput(answerSchema, { method: 'functionCalling' }),
  ).toThrow(expect.objectContaining({ code: 'unsupported' }));
  expect(() => fixture.model.withStructuredOutput(z.object({ answer: z.function() }))).toThrow(
    expect.objectContaining({ code: 'invalid' }),
  );
  expect(fixture.begin).not.toHaveBeenCalled();
});

test('plain JSON Schema replies receive client-side validation', async () => {
  const fixture = routed(new StructuredReplyModel('{"answer":"private-reply-canary"}'));
  expect(fixture.provider).toBeInstanceOf(StructuredReplyModel);
  await expect(
    fixture.model.withStructuredOutput(toJsonSchema(answerSchema)).invoke('hello'),
  ).rejects.toMatchObject({ code: 'invalid', message: toErrorInfo('invalid').message });
  expect(fixture.end).toHaveBeenCalledTimes(1);
});

test('incomplete JSON is invalid even when the LangChain parser can repair it', async () => {
  const fixture = routed(new StructuredReplyModel('{"answer":"yes"'));
  expect(fixture.provider).toBeInstanceOf(StructuredReplyModel);
  await expect(
    fixture.model.withStructuredOutput(answerSchema).invoke('hello'),
  ).rejects.toMatchObject({ code: 'invalid' });
  expect(fixture.end).toHaveBeenCalledTimes(1);
});
