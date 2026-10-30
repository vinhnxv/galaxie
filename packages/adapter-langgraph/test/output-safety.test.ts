// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createRuntime,
  type ModelCall,
  type ModelPort,
  type OutputSafetyHook,
} from '@galaxie/core';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  type StandardMessageStructure,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { expect, test, vi } from 'vitest';
import { toolCallChecks } from '../../../tests/conformance/support/tool-call-checks.js';
import { definition, FakeExecutor } from '../../core/test/fake-executor.js';
import { assertSpanTree, createSpanRecorder, serializeSpans } from '../../core/test/span-tree.js';
import { MockChatModel } from '../../models/src/mock.js';
import { RoutedChatModel } from '../src/routed-chat-model.js';
import { LangGraphTraceHandler } from '../src/trace-handler.js';

const sentinel = 'blocked-canary-29bc';
const text = `first ${sentinel} third`;

test.each(toolCallChecks)('shared tool argument check: $name', async ({ message, checked }) => {
  class CaseModel extends BaseChatModel {
    override _llmType(): string {
      return 'case';
    }
    override async _generate(): Promise<ChatResult> {
      const reply = new AIMessage(message);
      return { generations: [{ text: reply.text, message: reply }] };
    }
  }
  const checks: string[] = [];
  const f = await fixture(({ text }) => {
    checks.push(text);
    return 'allow';
  }, new CaseModel({}));
  try {
    await f.model.invoke('hello');
    expect(checks).toEqual([checked]);
  } finally {
    await f.runtime.dispose();
    await f.recorder.provider.shutdown();
  }
});

class Tokens extends BaseCallbackHandler {
  override name = 'tokens';
  readonly lc_prefer_streaming = true;
  readonly tokens: string[] = [];
  readonly texts: string[] = [];
  readonly events: unknown[] = [];
  override handleLLMNewToken(token: string): void {
    this.tokens.push(token);
  }
  override handleText(text: string): void {
    this.texts.push(text);
  }
  override handleChatModelStreamEvent(event: unknown): void {
    this.events.push(event);
  }
}

async function fixture(
  hook?: OutputSafetyHook,
  provider: BaseChatModel = new MockChatModel({ hello: { id: 'reply', text } }),
) {
  const recorder = createSpanRecorder();
  const active = Promise.withResolvers<{ models: ModelPort; handler: LangGraphTraceHandler }>();
  const executor = new FakeExecutor([
    async function* (request) {
      active.resolve({ models: request.models, handler: new LangGraphTraceHandler(request.trace) });
      await new Promise<void>((resolve) =>
        request.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      yield { type: 'output', output: 'finished' };
    },
  ]);
  const runtime = createRuntime({
    appId: 'test',
    executors: [executor],
    tracerProvider: recorder.provider,
    budgets: { tokens: 100 },
    ...(hook === undefined ? {} : { outputSafety: hook }),
  });
  const instance = await runtime.create(
    { ...definition, models: { assistant: { modality: 'text' } } },
    {
      principalScope: 'user',
      agent: {},
      models: {
        providers: {
          local: {
            destination: 'in-browser',
            modality: 'text',
            features: ['streaming', 'structured-output', 'tool-calling'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: { assistant: { providers: ['local'], allow: ['in-browser'], maxTokens: 100 } },
      },
    },
  );
  await instance.prepare();
  await instance.start('input');
  const { models, handler } = await active.promise;
  let lease: ModelCall | undefined;
  const model = new RoutedChatModel('assistant', { local: provider }, () => ({
    handler,
    models: {
      begin: async (role, options) => {
        lease = await models.begin(role, options);
        return lease;
      },
    },
  }));
  const tokens = new Tokens();
  return { model, tokens, handler, recorder, runtime, lease: () => lease };
}

test('stream blocks before yield and callbacks, settles the reservation and records only an outcome', async () => {
  const f = await fixture(({ text }) => (text.includes(sentinel) ? 'block' : 'allow'));
  const chunks: string[] = [];
  const consume = async (): Promise<void> => {
    for await (const chunk of await f.model.stream('hello', { callbacks: [f.tokens, f.handler] }))
      chunks.push(chunk.text);
  };
  await expect(consume()).rejects.toMatchObject({ code: 'denied' });
  expect(chunks).toEqual(['first ']);
  expect(f.tokens.tokens).toEqual(['first ']);
  expect(f.lease()?.outputSafetyOutcome).toBe('blocked');
  await expect(f.model.invoke('hello')).rejects.toMatchObject({ code: 'budget_exceeded' });
  await f.runtime.dispose();
  await f.recorder.provider.forceFlush();
  const spans = f.recorder.exporter.getFinishedSpans();
  expect(spans.find((span) => span.name.startsWith('chat'))?.attributes).toMatchObject({
    'galaxie.output_safety': 'blocked',
    'error.type': 'GalaxieError',
    'galaxie.step.status': 'error',
  });
  expect(serializeSpans(spans)).not.toContain(sentinel);
  assertSpanTree(spans);
  await f.recorder.provider.shutdown();
});

test.each(['stream', 'invoke'] as const)(
  'a final block fails %s after all non-final chunks passed',
  async (method) => {
    const checks: boolean[] = [];
    const f = await fixture(({ final }) => {
      checks.push(final);
      return final ? 'block' : 'allow';
    });
    const chunks: string[] = [];
    const consume = async (): Promise<void> => {
      if (method === 'invoke') await f.model.invoke('hello', { callbacks: [f.tokens] });
      else
        for await (const chunk of await f.model.stream('hello', { callbacks: [f.tokens] }))
          chunks.push(chunk.text);
    };
    await expect(consume()).rejects.toMatchObject({ code: 'denied' });
    expect(f.tokens.tokens).toEqual(['first ', `${sentinel} `, 'third']);
    if (method === 'stream') expect(chunks.join('')).toBe(text);
    expect(checks).toEqual([false, false, false, true]);
    await f.runtime.dispose();
    await f.recorder.provider.shutdown();
  },
);

test('non-streaming invoke checks full text exactly once before returning', async () => {
  const hook = vi.fn<OutputSafetyHook>(() => 'block');
  const f = await fixture(hook);
  await expect(f.model.invoke('hello')).rejects.toMatchObject({ code: 'denied' });
  expect(hook).toHaveBeenCalledTimes(1);
  expect(hook.mock.calls[0]?.[0]).toMatchObject({ text, final: true });
  await f.runtime.dispose();
  await f.recorder.provider.shutdown();
});

test('streaming invoke emits each token after its accumulated check', async () => {
  const order: string[] = [];
  const f = await fixture(({ text, final }) => {
    order.push(`${final ? 'final' : 'check'}:${text}`);
    return 'allow';
  });
  f.tokens.handleLLMNewToken = (token: string): void => {
    order.push(`token:${token}`);
  };
  await f.model.invoke('hello', { callbacks: [f.tokens] });
  expect(order).toEqual([
    'check:first ',
    'token:first ',
    `check:first ${sentinel} `,
    `token:${sentinel} `,
    `check:${text}`,
    'token:third',
    `final:${text}`,
  ]);
  await f.runtime.dispose();
  await f.recorder.provider.shutdown();
});

class ToolProvider extends BaseChatModel {
  override _llmType(): string {
    return 'fake-tools';
  }
  override async _generate(): Promise<ChatResult> {
    return {
      generations: [
        {
          text: 'visible',
          message: new AIMessage<StandardMessageStructure>({
            content: [{ type: 'text', text: 'visible' }],
            tool_calls: [{ name: 'answer', args: { reply: sentinel }, id: 'tool' }],
          }),
        },
      ],
    };
  }
}

test.each(['invoke', 'bridge'] as const)('checks tool arguments in %s', async (method) => {
  const checks: string[] = [];
  const f = await fixture(({ text }) => {
    checks.push(text);
    return text.includes(sentinel) ? 'block' : 'allow';
  }, new ToolProvider({}));
  const consume = async (): Promise<void> => {
    if (method === 'invoke') await f.model.invoke('hello');
    else
      for await (const _chunk of await f.model.stream('hello', { callbacks: [f.tokens] })) {
      }
  };
  await expect(consume()).rejects.toMatchObject({ code: 'denied' });
  expect(checks).toEqual([`visible\n${JSON.stringify({ reply: sentinel })}`]);
  expect(f.tokens.tokens).toEqual([]);
  await f.runtime.dispose();
  await f.recorder.provider.shutdown();
});

class CallbackProvider extends ToolProvider {
  readonly managers: (CallbackManagerForLLMRun | undefined)[] = [];
  override async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    manager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.managers.push(manager);
    await manager?.handleText('provider lifecycle');
    await manager?.handleLLMNewToken(sentinel);
    await manager?.handleChatModelStreamEvent({
      event: 'content-block-delta',
      index: 0,
      delta: { type: 'text-delta', text: sentinel },
    });
    yield new ChatGenerationChunk({
      text: 'visible',
      message: new AIMessageChunk<StandardMessageStructure>('visible'),
    });
  }
}

class ToolStreamProvider extends ToolProvider {
  override async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
    for (const args of ['{"reply":"', `${sentinel}"}`]) {
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk<StandardMessageStructure>({
          content: '',
          tool_call_chunks: [{ index: 0, args }],
        }),
      });
    }
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk<StandardMessageStructure>(''),
    });
  }
}

test.each(['allow', 'block'] as const)(
  'accumulates tool argument fragments and skips unchanged metadata chunks: %s',
  async (verdict) => {
    const checks: { text: string; final: boolean }[] = [];
    const f = await fixture(({ text, final }) => {
      checks.push({ text, final });
      return text.includes(sentinel) ? verdict : 'allow';
    }, new ToolStreamProvider({}));
    const chunks: unknown[] = [];
    const consume = async (): Promise<void> => {
      for await (const chunk of await f.model.stream('hello', { callbacks: [f.tokens] }))
        chunks.push(chunk);
    };
    if (verdict === 'allow') {
      await consume();
      expect(checks).toEqual([
        { text: '\n{"reply":"', final: false },
        { text: `\n${JSON.stringify({ reply: sentinel })}`, final: false },
        { text: `\n${JSON.stringify({ reply: sentinel })}`, final: true },
      ]);
      expect(chunks).toHaveLength(3);
    } else {
      await expect(consume()).rejects.toMatchObject({ code: 'denied' });
      expect(chunks).toHaveLength(1);
      expect(JSON.stringify(chunks)).not.toContain(sentinel);
      expect(f.tokens.tokens).toHaveLength(1);
    }
    await f.runtime.dispose();
    await f.recorder.provider.shutdown();
  },
);

class GenerateCallbackProvider extends BaseChatModel {
  override _llmType(): string {
    return 'fake-generate-callbacks';
  }
  override async _generate(
    _messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    manager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    await manager?.handleText('provider lifecycle');
    await manager?.handleLLMNewToken(sentinel);
    await manager?.handleChatModelStreamEvent({
      event: 'content-block-delta',
      index: 0,
      delta: { type: 'text-delta', text: sentinel },
    });
    return {
      generations: [
        { text: 'visible', message: new AIMessage<StandardMessageStructure>('visible') },
      ],
    };
  }
}

test('non-streaming generation filters provider token callbacks before the final check', async () => {
  const f = await fixture(() => 'block', new GenerateCallbackProvider({}));
  const tokens: string[] = [];
  const events: unknown[] = [];
  await expect(
    f.model.invoke('hello', {
      callbacks: [
        {
          handleLLMNewToken: (token: string) => {
            tokens.push(token);
          },
          handleChatModelStreamEvent: (event: unknown) => {
            events.push(event);
          },
        },
      ],
    }),
  ).rejects.toMatchObject({ code: 'denied' });
  expect(tokens).toEqual([]);
  expect(events).toEqual([]);
  await f.runtime.dispose();
  await f.recorder.provider.shutdown();
});

test('filters both provider token paths while retaining other callbacks and manager properties', async () => {
  const provider = new CallbackProvider({});
  const f = await fixture(() => 'allow', provider);
  const chunks: string[] = [];
  for await (const chunk of await f.model.stream('hello', { callbacks: [f.tokens] }))
    chunks.push(chunk.text);
  expect(chunks).toEqual(['visible']);
  expect(f.tokens.tokens).toEqual(['visible']);
  expect(f.tokens.events).toEqual([]);
  expect(f.tokens.texts).toEqual(['provider lifecycle']);
  expect(provider.managers[0]?.runId).toEqual(expect.any(String));
  expect(provider.managers[0]?.handlers).toContain(f.tokens);
  await f.runtime.dispose();
  await f.recorder.provider.shutdown();
});

test('structured output fails with denied before validation', async () => {
  const f = await fixture(() => 'block');
  await expect(
    f.model
      .withStructuredOutput({ type: 'object', properties: { answer: { type: 'string' } } })
      .invoke('hello'),
  ).rejects.toMatchObject({ code: 'denied' });
  await f.runtime.dispose();
  await f.recorder.provider.shutdown();
});

class ArgumentFormsProvider extends BaseChatModel {
  readonly #form: 'complete' | 'invalid' | 'mixed';
  constructor(form: 'complete' | 'invalid' | 'mixed', bridge = false) {
    super({});
    this.#form = form;
    this.disableStreaming = bridge;
  }
  override _llmType(): string {
    return 'fake-argument-forms';
  }
  override async _generate(): Promise<ChatResult> {
    const valid = {
      id: 'valid',
      type: 'function' as const,
      function: {
        name: 'answer',
        arguments: JSON.stringify({ reply: this.#form === 'complete' ? sentinel : 'safe' }),
      },
    };
    const invalid = {
      id: 'invalid',
      type: 'function' as const,
      function: { name: 'answer', arguments: `{"reply":"${sentinel}` },
    };
    const message = new AIMessage<StandardMessageStructure>({
      content: 'visible',
      additional_kwargs: {
        tool_calls:
          this.#form === 'complete'
            ? [valid]
            : this.#form === 'invalid'
              ? [invalid]
              : [valid, invalid],
      },
    });
    return { generations: [{ text: message.text, message }] };
  }
  override async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
    const result = await this._generate();
    const message = result.generations[0]?.message;
    if (message === undefined) throw new Error('The fake reply is missing.');
    yield new ChatGenerationChunk({
      text: message.text,
      message: new AIMessageChunk<StandardMessageStructure>({ ...message }),
    });
  }
}

test.each([
  ['complete', 'stream'],
  ['complete', 'streaming invoke'],
  ['invalid', 'invoke'],
  ['invalid', 'stream'],
  ['mixed', 'bridge'],
] as const)('checks %s tool arguments through %s before release', async (form, method) => {
  const checks: string[] = [];
  const f = await fixture(
    ({ text }) => {
      checks.push(text);
      return text.includes(sentinel) ? 'block' : 'allow';
    },
    new ArgumentFormsProvider(form, method === 'bridge'),
  );
  const chunks: unknown[] = [];
  const consume = async (): Promise<void> => {
    if (method === 'invoke') await f.model.invoke('hello');
    else if (method === 'streaming invoke')
      await f.model.invoke('hello', { callbacks: [f.tokens] });
    else
      for await (const chunk of await f.model.stream('hello', { callbacks: [f.tokens] }))
        chunks.push(chunk);
  };
  await expect(consume()).rejects.toMatchObject({ code: 'denied' });
  expect(checks[0]).toContain(sentinel);
  expect(chunks).toEqual([]);
  expect(f.tokens.tokens).toEqual([]);
  expect(f.tokens.events).toEqual([]);
  await f.runtime.dispose();
  await f.recorder.provider.shutdown();
});

class SequenceProvider extends BaseChatModel {
  readonly #chunks: readonly ChatGenerationChunk[];
  constructor(chunks: readonly ChatGenerationChunk[]) {
    super({});
    this.#chunks = chunks;
  }
  override _llmType(): string {
    return 'fake-sequence';
  }
  override async _generate(): Promise<ChatResult> {
    return {
      generations: [{ text: 'unused', message: new AIMessage<StandardMessageStructure>('unused') }],
    };
  }
  override async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
    yield* this.#chunks;
  }
}

function argumentChunk(text: string, args?: string, index = 0): ChatGenerationChunk {
  return new ChatGenerationChunk({
    text,
    message: new AIMessageChunk<StandardMessageStructure>({
      content: text,
      ...(args === undefined
        ? {}
        : { tool_call_chunks: [{ name: 'answer', id: `tool-${index}`, index, args }] }),
    }),
  });
}

test('retains complete arguments after later fragments when the final check blocks', async () => {
  const complete = new ChatGenerationChunk({
    text: '',
    message: new AIMessageChunk<StandardMessageStructure>({
      content: '',
      tool_calls: [{ name: 'answer', id: 'complete', args: { reply: sentinel } }],
    }),
  });
  const checks: string[] = [];
  const f = await fixture(
    ({ text, final }) => {
      checks.push(text);
      return final && text.includes(sentinel) ? 'block' : 'allow';
    },
    new SequenceProvider([complete, argumentChunk('', '{}', 1)]),
  );
  await expect(f.model.invoke('hello', { callbacks: [f.tokens] })).rejects.toMatchObject({
    code: 'denied',
  });
  expect(checks).toHaveLength(3);
  for (const checked of checks) expect(checked).toContain(sentinel);
  expect(f.tokens.tokens).toHaveLength(2);
  await f.runtime.dispose();
  await f.recorder.provider.shutdown();
});

test.each(['separate malformed call', 'mirrored fragment'] as const)(
  'checks raw arguments beside fragments: %s',
  async (kind) => {
    const rawArgs = kind === 'mirrored fragment' ? '{}' : `{"reply":"${sentinel}`;
    const message = new AIMessageChunk<StandardMessageStructure>({
      content: '',
      tool_call_chunks: [{ index: 0, name: 'safe', id: 'safe', args: '{}' }],
      additional_kwargs: {
        tool_calls: [
          {
            id: kind === 'mirrored fragment' ? 'safe' : 'invalid',
            type: 'function',
            function: {
              name: kind === 'mirrored fragment' ? 'safe' : 'answer',
              arguments: rawArgs,
            },
          },
        ],
      },
    });
    const checks: string[] = [];
    const f = await fixture(
      ({ text }) => {
        checks.push(text);
        return text.includes(sentinel) ? 'block' : 'allow';
      },
      new SequenceProvider([new ChatGenerationChunk({ text: '', message })]),
    );
    const chunks: unknown[] = [];
    const consume = async (): Promise<void> => {
      for await (const chunk of await f.model.stream('hello', { callbacks: [f.tokens] }))
        chunks.push(chunk);
    };
    if (kind === 'mirrored fragment') {
      await consume();
      expect(checks).toEqual(['\n{}', '\n{}']);
      expect(chunks).toHaveLength(1);
    } else {
      await expect(consume()).rejects.toMatchObject({ code: 'denied' });
      expect(checks[0]).toContain(sentinel);
      expect(chunks).toEqual([]);
      expect(f.tokens.tokens).toEqual([]);
    }
    await f.runtime.dispose();
    await f.recorder.provider.shutdown();
  },
);

test.each(['text', 'argument', 'parallel arguments'] as const)(
  'interleaving cannot hide contiguous %s',
  async (kind) => {
    const blocked = 'blocked-canary';
    const chunks =
      kind === 'text'
        ? [argumentChunk('blocked-'), argumentChunk('', '{}'), argumentChunk('canary')]
        : [
            argumentChunk('', '{"reply":"blocked-'),
            kind === 'argument' ? argumentChunk('{}') : argumentChunk('', '{}', 1),
            argumentChunk('', 'canary"}'),
          ];
    const checks: string[] = [];
    const f = await fixture(({ text }) => {
      checks.push(text);
      return text.includes(blocked) ? 'block' : 'allow';
    }, new SequenceProvider(chunks));
    const released: ChatGenerationChunk['message'][] = [];
    const consume = async (): Promise<void> => {
      for await (const chunk of await f.model.stream('hello', { callbacks: [f.tokens] }))
        released.push(chunk);
    };
    await expect(consume()).rejects.toMatchObject({ code: 'denied' });
    expect(checks.at(-1)).toContain(blocked);
    expect(released).toHaveLength(2);
    expect(f.tokens.tokens).toHaveLength(2);
    expect(JSON.stringify(released)).not.toContain(blocked);
    await f.runtime.dispose();
    await f.recorder.provider.shutdown();
  },
);

test('without a hook tokens are emitted once and the model span reports unset', async () => {
  const f = await fixture();
  await f.model.invoke('hello', { callbacks: [f.tokens, f.handler] });
  expect(f.tokens.tokens.join('')).toBe(text);
  expect(f.tokens.tokens).toHaveLength(3);
  await f.runtime.dispose();
  await f.recorder.provider.forceFlush();
  expect(
    f.recorder.exporter.getFinishedSpans().find((span) => span.name.startsWith('chat'))?.attributes[
      'galaxie.output_safety'
    ],
  ).toBe('unset');
  await f.recorder.provider.shutdown();
});

test('the chat-model stream-event bridge still checks text without a run manager', async () => {
  const f = await fixture(({ text }) => (text.includes(sentinel) ? 'block' : 'allow'));
  const chunks: unknown[] = [];
  const consume = async (): Promise<void> => {
    for await (const event of f.model._streamChatModelEvents([new HumanMessage('hello')], {}))
      chunks.push(event);
  };
  await expect(consume()).rejects.toMatchObject({ code: 'denied' });
  expect(JSON.stringify(chunks)).toContain('first ');
  expect(JSON.stringify(chunks)).not.toContain(sentinel);
  await f.runtime.dispose();
  await f.recorder.provider.shutdown();
});

test('streamEvents exposes only chunks that passed the hook', async () => {
  const f = await fixture(({ text }) => (text.includes(sentinel) ? 'block' : 'allow'));
  const chunks: unknown[] = [];
  const consume = async (): Promise<void> => {
    for await (const event of f.model.streamEvents('hello', { version: 'v2' }))
      if (event.event === 'on_chat_model_stream') chunks.push(event.data);
  };
  await expect(consume()).rejects.toMatchObject({ code: 'denied' });
  expect(JSON.stringify(chunks)).toContain('first ');
  expect(JSON.stringify(chunks)).not.toContain(sentinel);
  await f.runtime.dispose();
  await f.recorder.provider.shutdown();
});
