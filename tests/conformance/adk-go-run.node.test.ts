// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createRuntime,
  defineAgentDefinition,
  type RunEvent,
  type RuntimeOptions,
} from '@galaxie/core';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  type StandardMessageStructure,
  type ToolCall,
} from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
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

/** Answers each call from the next scripted reply and records the history it was shown. */
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
  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
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

/** Opens an instance on the reference module with a scripted model and a doubling capability. */
async function open(
  runtime: ReturnType<typeof createRuntime>,
  entry: string,
  replies: readonly Reply[],
) {
  if (!host) throw new Error('The host did not start.');
  const model = new SequenceModel(replies);
  const invoked: number[] = [];
  const instance = await runtime.create(definition, {
    principalScope: 'fixture',
    agent: { wasm: host.wasm, entry },
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
      for await (const event of instance.events(runId)) recorded.push(event);
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
  return { model, run, invoked, instance };
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
      // The loop never calls the model; cancel once the run has begun.
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
