// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  type RunEvent,
  type RuntimeOptions,
} from '@galaxie/core';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  type StandardMessageStructure,
  type ToolCall,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { z } from 'zod';
import { createGoAdapter } from '../../packages/adapter-go/src/index.js';
import {
  buildReference,
  disposeReference,
  goAvailable,
  missingGo,
  type NodeHost,
  startNodeHost,
} from './support/adk-go.node.js';

type Reply =
  | { readonly text: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly error: Error }
  | { readonly wait: Promise<void>; readonly entered: () => void };

class SequenceModel extends BaseChatModel {
  readonly requests: string[][] = [];
  readonly #replies: readonly Reply[];
  #index = 0;
  constructor(replies: readonly Reply[]) {
    super({});
    this.#replies = replies;
  }
  override _llmType(): string {
    return 'adk-go-sequence';
  }
  override bindTools(): this {
    return this;
  }
  /** Streams a text reply word by word, so a check or an abort can land between two deltas. */
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): AsyncGenerator<ChatGenerationChunk> {
    const reply = await this.#next(messages, options);
    for (const text of reply.text.match(/\S+\s*/g) ?? ['']) {
      options.signal?.throwIfAborted();
      yield new ChatGenerationChunk({
        text,
        message: new AIMessageChunk<StandardMessageStructure>({ content: text }),
      });
    }
  }
  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const reply = await this.#next(messages, options);
    return {
      generations: [
        {
          text: reply.text,
          message: new AIMessage<StandardMessageStructure>({
            content: reply.text,
            ...(reply.toolCalls ? { tool_calls: [...reply.toolCalls] } : {}),
            usage_metadata: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
          }),
        },
      ],
    };
  }
  async #next(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<{ readonly text: string; readonly toolCalls?: readonly ToolCall[] }> {
    this.requests.push(
      messages.map((message) => `${message.type}:${JSON.stringify(message.content)}`),
    );
    const reply = this.#replies[this.#index++];
    if (!reply) throw new Error('The sequence has no more replies.');
    if ('error' in reply) throw reply.error;
    if ('wait' in reply) {
      reply.entered();
      await Promise.race([
        reply.wait,
        new Promise<never>((_, reject) =>
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          }),
        ),
      ]);
      throw new Error('The waiting reply was released.');
    }
    return reply;
  }
}

const double = (id: string, value: unknown): ToolCall => ({
  id,
  name: 'math_double_1',
  args: { value },
  type: 'tool_call',
});

const definition = defineAgentDefinition({
  id: 'conformance/adk-go-run',
  version: '1.0.0',
  executor: 'adk-go',
  input: z.object({ prompt: z.string() }),
  capabilities: {
    required: {
      'math.double@1': {
        kind: 'read',
        input: z.object({ value: z.number() }),
        output: z.object({ value: z.number() }),
      },
    },
  },
  models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
});

interface Outcome {
  output?: unknown;
  error?: { code: string };
  cancelled: boolean;
}

let host: NodeHost | undefined;
beforeAll(async () => {
  if (goAvailable) host = await startNodeHost(await buildReference());
}, 600000);
afterAll(async () => {
  await host?.close();
  await disposeReference();
});

async function open(
  runtime: ReturnType<typeof createRuntime>,
  entry: string,
  replies: readonly Reply[],
  stream = false,
) {
  if (!host) throw new Error('The host did not start.');
  const model = new SequenceModel(replies);
  const invoked: number[] = [];
  const deltas: string[] = [];
  const firstDelta = Promise.withResolvers<void>();
  const instance = await runtime.create(definition, {
    principalScope: 'fixture',
    agent: { wasm: host.wasm, entry, ...(stream ? { stream: true } : {}) },
    services: { chatModels: { mock: model } },
    bindings: {
      'math.double@1': {
        kind: 'read',
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 4,
        grantScope: 'instance',
        approval: 'none',
        retry: 'none',
        async invoke(input: { value: number }) {
          invoked.push(input.value);
          return { value: input.value * 2 };
        },
      },
    },
    models: {
      providers: {
        mock: {
          destination: 'in-browser',
          modality: 'text',
          languages: ['en'],
          features: ['tool-calling'],
          pricing: { inputPerToken: 0, outputPerToken: 0 },
        },
      },
      roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
    },
  });
  await instance.prepare();
  const run = async (prompt: string, cancelWhen?: Promise<void>): Promise<Outcome> => {
    const { runId } = await instance.start({ prompt });
    const events = (async () => {
      const recorded: RunEvent[] = [];
      for await (const event of instance.events(runId)) {
        recorded.push(event);
        if (event.type === 'stream' && event.mode === 'messages') {
          deltas.push(String((event.data as { text: unknown }).text));
          firstDelta.resolve();
        }
      }
      return recorded;
    })();
    if (cancelWhen) {
      await cancelWhen;
      await instance.cancel(runId);
    }
    const result: Outcome = { cancelled: false };
    for (const event of await events) {
      if (event.type === 'output') result.output = event.output;
      else if (event.type === 'error') result.error = event.error;
      else if (event.type === 'cancelled') result.cancelled = true;
    }
    return result;
  };
  return { model, run, invoked, instance, deltas, firstDelta: firstDelta.promise };
}

function runtimeWith(options: Partial<RuntimeOptions> = {}): ReturnType<typeof createRuntime> {
  if (!host) throw new Error('The host did not start.');
  const nodeHost = host;
  return createRuntime({
    appId: 'adk-go-run',
    executors: [createGoAdapter({ createWorker: () => nodeHost.createWorker() })],
    budgets: { steps: 10, toolCalls: 10, tokens: 5000 },
    outputSafety: () => 'allow',
    ...options,
  });
}

test.skipIf(!goAvailable)(
  goAvailable ? 'a model that raises ends the run with the raised code' : missingGo,
  async () => {
    const runtime = runtimeWith();
    try {
      const { run } = await open(runtime, 'single', [
        { error: new Error('PRIVATE PROVIDER DETAIL') },
      ]);
      const outcome = await run('boom');
      expect(outcome.error?.code).toBe('unavailable');
      expect(JSON.stringify(outcome)).not.toContain('PRIVATE PROVIDER DETAIL');
    } finally {
      await runtime.dispose();
    }
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable
    ? 'a capability runs once and a step budget stops the run before dispatch'
    : missingGo,
  async () => {
    const runtime = runtimeWith({ budgets: { steps: 1, toolCalls: 10, tokens: 5000 } });
    try {
      const { run, invoked, model } = await open(runtime, 'single-tool', [
        { text: '', toolCalls: [double('a', 21)] },
        { text: 'never' },
      ]);
      const outcome = await run('go');
      expect(outcome.error?.code).toBe('budget_exceeded');
      expect(invoked).toEqual([21]);
      expect(model.requests).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable ? 'a blocked tool argument fails denied and never reaches the Worker' : missingGo,
  async () => {
    const runtime = runtimeWith({
      outputSafety: ({ text }) => (/BLOCKED_ARGUMENT/.test(text) ? 'block' : 'allow'),
    });
    try {
      const before = host?.traffic.length ?? 0;
      const { run, invoked } = await open(runtime, 'single-tool', [
        { text: '', toolCalls: [double('a', 'BLOCKED_ARGUMENT')] },
        { text: 'never' },
      ]);
      expect((await run('go')).error?.code).toBe('denied');
      expect(invoked).toEqual([]);
      expect((host?.traffic.slice(before) ?? []).join('\n')).not.toContain('BLOCKED_ARGUMENT');
    } finally {
      await runtime.dispose();
    }
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable ? 'abort settles cancelled and the adapter serves another run' : missingGo,
  async () => {
    const runtime = runtimeWith();
    try {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const { run } = await open(runtime, 'single', [
        { wait: release.promise, entered: () => entered.resolve() },
        { text: 'again' },
      ]);
      const started = Date.now();
      const aborted = await run('slow', entered.promise);
      release.resolve();
      expect(aborted.cancelled).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
      expect((await run('next')).output).toBe('again');
    } finally {
      await runtime.dispose();
    }
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable
    ? 'a streamed reply blocked mid-stream fails denied and the blocked delta never reaches the host'
    : missingGo,
  async () => {
    const runtime = runtimeWith({
      outputSafety: ({ text }) => (/BLOCKED_TEXT/.test(text) ? 'block' : 'allow'),
    });
    try {
      const before = host?.traffic.length ?? 0;
      const { run, deltas } = await open(
        runtime,
        'single',
        [{ text: 'safe BLOCKED_TEXT after' }],
        true,
      );
      expect((await run('go')).error?.code).toBe('denied');
      expect(deltas).toEqual(['safe ']);
      expect((host?.traffic.slice(before) ?? []).join('\n')).not.toContain('BLOCKED_TEXT');
    } finally {
      await runtime.dispose();
    }
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable
    ? 'abort during a streamed reply stops the deltas and the adapter serves another run'
    : missingGo,
  async () => {
    let checks = 0;
    const runtime = runtimeWith({
      outputSafety: async (): Promise<'allow'> => {
        checks += 1;
        // The second check is still pending when the abort lands, so the next delta must not leave.
        if (checks === 2) await new Promise((resolve) => setTimeout(resolve, 100));
        return 'allow';
      },
    });
    try {
      const { run, deltas, firstDelta } = await open(
        runtime,
        'single',
        [{ text: 'alpha beta gamma' }, { text: 'again' }],
        true,
      );
      expect((await run('slow', firstDelta)).cancelled).toBe(true);
      expect(deltas).toEqual(['alpha ']);
      expect((await run('next')).output).toBe('again');
    } finally {
      await runtime.dispose();
    }
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable
    ? 'agent code that panics fails the run with a fixed code and the Worker survives'
    : missingGo,
  async () => {
    const runtime = runtimeWith();
    try {
      const first = await open(runtime, 'panic', [{ text: 'never' }]);
      const outcome = await first.run('go');
      expect(outcome.error?.code).toBe('executor_error');
      expect(JSON.stringify(outcome)).not.toContain('conformance panic');
    } finally {
      await runtime.dispose();
    }
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable
    ? 'agent code that exits fails the run unavailable and the next prepare builds a new Worker'
    : missingGo,
  async () => {
    if (!host) throw new Error('The host did not start.');
    const runtime = runtimeWith();
    try {
      const before = host.workers.length;
      const first = await open(runtime, 'exit', [{ text: 'never' }]);
      const outcome = await first.run('go');
      expect(outcome.error?.code).toBe('unavailable');
      expect(JSON.stringify(outcome)).not.toMatch(/exit status|code 3/);
      const second = await open(runtime, 'single', [{ text: 'fine' }]);
      expect(host.workers.length).toBeGreaterThan(before + 1);
      expect((await second.run('go')).output).toBe('fine');
    } finally {
      await runtime.dispose();
    }
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable
    ? 'a Go loop that ignores its context is terminated and the session is unrecoverable'
    : missingGo,
  async () => {
    const runtime = runtimeWith();
    try {
      const stuck = await open(runtime, 'spin', [{ text: 'never' }]);
      const started = Date.now();
      const settled = await stuck.run('go', new Promise((resolve) => setTimeout(resolve, 300)));
      expect(settled.cancelled).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
      expect((await stuck.run('again')).error?.code).toBe('unrecoverable');
      const fresh = await open(runtime, 'single', [{ text: 'works' }]);
      expect((await fresh.run('go')).output).toBe('works');
    } finally {
      await runtime.dispose();
    }
  },
  120000,
);

type Instance = Awaited<ReturnType<typeof open>>['instance'];

/** Runs a prompt and answers each interaction with `answer`; reports the receipts and the outcome. */
async function converse(
  instance: Instance,
  prompt: string,
  answer: (index: number) => { action: string; payload: unknown; interactionId?: string },
): Promise<{
  interactions: Array<{ interactionId: string; props: unknown }>;
  receipts: Array<{ status: string }>;
  output?: unknown;
  error?: { code: string };
}> {
  const { runId } = await instance.start({ prompt });
  const result: Awaited<ReturnType<typeof converse>> = { interactions: [], receipts: [] };
  for await (const event of instance.events(runId)) {
    if (event.type === 'interaction') {
      const index = result.interactions.length;
      result.interactions.push({
        interactionId: event.interaction.interactionId,
        props: event.interaction.props,
      });
      const reply = answer(index);
      result.receipts.push(
        await instance.dispatch({
          instanceId: instance.instanceId,
          runId,
          ...event.interaction,
          ...(reply.interactionId === undefined
            ? {}
            : { interactionId: reply.interactionId as never }),
          action: reply.action,
          payload: reply.payload,
        }),
      );
      if (reply.interactionId !== undefined) {
        // A rejected answer leaves the pause; the right one follows.
        const retry = answer(index + 1000);
        result.receipts.push(
          await instance.dispatch({
            instanceId: instance.instanceId,
            runId,
            ...event.interaction,
            action: retry.action,
            payload: retry.payload,
          }),
        );
      }
    } else if (event.type === 'output') result.output = event.output;
    else if (event.type === 'error') result.error = event.error;
  }
  return result;
}

const approve = (indexes: number[]): { action: string; payload: unknown } => ({
  action: 'approve',
  payload: { indexes },
});

test.skipIf(!goAvailable)(
  goAvailable
    ? 'two confirmations in one response form one interaction that one answer covers'
    : missingGo,
  async () => {
    const runtime = runtimeWith();
    try {
      const { instance, invoked, model } = await open(runtime, 'confirm', [
        { text: '', toolCalls: [double('a', 1), double('b', 2)] },
        { text: 'Both doubled.' },
      ]);
      const outcome = await converse(instance, 'go', () => approve([0, 1]));
      expect(outcome.interactions).toHaveLength(1);
      expect(outcome.interactions[0]?.props).toEqual({ count: 2 });
      expect(outcome.receipts.map((receipt) => receipt.status)).toEqual(['accepted']);
      expect(outcome.output).toBe('Both doubled.');
      expect([...invoked].sort()).toEqual([1, 2]);
      expect(model.requests).toHaveLength(2);
    } finally {
      await runtime.dispose();
    }
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable ? 'an answer that misses one confirmation fails invalid and runs nothing' : missingGo,
  async () => {
    const runtime = runtimeWith();
    try {
      const { instance, invoked } = await open(runtime, 'confirm', [
        { text: '', toolCalls: [double('a', 1), double('b', 2)] },
        { text: 'never' },
      ]);
      const outcome = await converse(instance, 'go', () => approve([0]));
      expect(outcome.error?.code).toBe('invalid');
      expect(invoked).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable
    ? 'an answer to another interaction is rejected stale and the pause stays'
    : missingGo,
  async () => {
    const runtime = runtimeWith();
    try {
      const { instance, invoked } = await open(runtime, 'confirm', [
        { text: '', toolCalls: [double('a', 21)] },
        { text: 'Doubled.' },
      ]);
      const outcome = await converse(instance, 'go', (index) => ({
        ...approve([0]),
        ...(index < 1000 ? { interactionId: 'f'.repeat(64) } : {}),
      }));
      expect(outcome.receipts.map((receipt) => receipt.status)).toEqual(['rejected', 'accepted']);
      expect(outcome.output).toBe('Doubled.');
      expect(invoked).toEqual([21]);
    } finally {
      await runtime.dispose();
    }
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable ? 'consecutive pauses of one session have distinct interaction IDs' : missingGo,
  async () => {
    const runtime = runtimeWith();
    try {
      const { instance, invoked } = await open(runtime, 'confirm', [
        { text: '', toolCalls: [double('a', 1)] },
        { text: '', toolCalls: [double('b', 2)] },
        { text: 'Twice.' },
      ]);
      const first = await converse(instance, 'go', () => approve([0]));
      expect(first.interactions).toHaveLength(2);
      const ids = first.interactions.map((item) => item.interactionId);
      expect(new Set(ids).size).toBe(2);
      expect(invoked).toEqual([1, 2]);
    } finally {
      await runtime.dispose();
    }
  },
  120000,
);
