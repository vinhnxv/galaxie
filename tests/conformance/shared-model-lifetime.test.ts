// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import { createRuntime, defineAgentDefinition, type Runtime } from '@galaxie/core';
import { BuiltInAIChatModel } from '@galaxie/models/builtin-ai';
import { WebLLMChatModel } from '@galaxie/models/webllm';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { collect } from '../../packages/core/test/fake-executor.js';
import { type NetworkRecorder, recordNetwork } from '../../packages/core/test/network-recorder.js';
import { createWebLLMEngine } from '../../packages/models/src/webllm/engine.js';
import {
  FakeLanguageModel,
  installLanguageModel,
} from '../../packages/models/test/support/fake-language-model.js';
import {
  createFakeWebLLM,
  FakeWebLLMStream,
} from '../../packages/models/test/support/fake-webllm.js';

const state = Annotation.Root({ characters: Annotation<number> });
const definition = defineAgentDefinition({
  id: 'conformance/shared-model-lifetime',
  version: '1.0.0',
  executor: 'langgraph-js',
  input: z.object({}),
  models: { assistant: { modality: 'text', languages: ['en'] } },
});
type TestRuntime = Runtime<readonly [ReturnType<typeof createLangGraphAdapter>]>;

let network: NetworkRecorder;
let nodeNetwork: NetworkRecorder | undefined;

beforeEach(async () => {
  network = recordNetwork(typeof window === 'undefined' ? undefined : window.location.origin);
  nodeNetwork =
    typeof window === 'undefined'
      ? (await import('./support/network.node.js')).recordNodeNetwork()
      : undefined;
  await network.selfTest();
  await nodeNetwork?.selfTest();
});

afterEach(() => {
  try {
    expect(network.calls).toEqual([]);
    expect(nodeNetwork?.calls ?? []).toEqual([]);
  } finally {
    network.restore();
    nodeNetwork?.restore();
    vi.restoreAllMocks();
  }
});

function createTestRuntime(): TestRuntime {
  return createRuntime({ appId: 'shared-model-lifetime', executors: [createLangGraphAdapter()] });
}

async function createConsumer(runtime: TestRuntime, model: BaseChatModel) {
  const instance = await runtime.create(definition, {
    principalScope: 'shared-model-lifetime',
    services: { chatModels: { local: model } },
    models: {
      providers: {
        local: {
          destination: 'in-browser',
          modality: 'text',
          languages: ['en'],
          features: ['streaming', 'cancellation'],
          pricing: { inputPerToken: 0, outputPerToken: 0 },
        },
      },
      roles: { assistant: { providers: ['local'], allow: ['in-browser'], maxTokens: 100 } },
    },
    agent: (host) =>
      new StateGraph(state)
        .addNode('respond', async (_state, config) => {
          let characters = 0;
          // Native nostream and projection keep reply text out of this fixture's raw events.
          for await (const chunk of await host.langchain
            .chatModel('assistant')
            .stream([new HumanMessage('shared lifetime prompt canary')], {
              ...config,
              tags: ['nostream'],
            })) {
            if (typeof chunk.content === 'string') characters += chunk.content.length;
          }
          return { characters };
        })
        .addEdge(START, 'respond')
        .addEdge('respond', END)
        .compile(),
  });
  await instance.prepare();
  return instance;
}

async function expectCompleted(instance: Awaited<ReturnType<typeof createConsumer>>) {
  const { runId } = await instance.start({});
  const events = await collect(instance.events(runId));
  expect(events.at(-1)).toMatchObject({ type: 'output', output: { characters: 11 } });
  expect(instance.getSnapshot().run?.status).toBe('succeeded');
  return events;
}

test('shared WebLLM survives consumer cancellation and disposal until host teardown', async () => {
  const entered = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  let calls = 0;
  const fake = createFakeWebLLM({
    create: async () =>
      ++calls === 3
        ? new FakeWebLLMStream(undefined, {
            beforeNext: async (index) => {
              if (index === 1) {
                entered.resolve();
                await blocked.promise;
              }
            },
          })
        : new FakeWebLLMStream(),
  });
  const handle = await createWebLLMEngine(
    { worker: fake.worker },
    { gpu: fake.gpu, loadModule: async () => fake.module },
  );
  const streams = vi.spyOn(handle, 'stream');
  const runtime = createTestRuntime();
  try {
    const model = new WebLLMChatModel(handle);
    const a = await createConsumer(runtime, model);
    const b = await createConsumer(runtime, model);
    await expectCompleted(a);
    await expectCompleted(b);

    const cancelled = await a.start({});
    await entered.promise;
    const queued = await b.start({});
    // B has reached the shared handle while A still owns the FIFO turn.
    await vi.waitFor(() => expect(streams).toHaveBeenCalledTimes(4));
    expect(fake.engine.requests).toHaveLength(3);
    expect(b.getSnapshot().run?.status).toBe('running');
    expect(fake.engine.unloads).toBe(0);

    await a.cancel(cancelled.runId);
    expect((await collect(a.events(cancelled.runId))).at(-1)?.type).toBe('cancelled');
    expect((await collect(b.events(queued.runId))).at(-1)).toMatchObject({
      type: 'output',
      output: { characters: 11 },
    });
    expect(b.getSnapshot().run?.status).toBe('succeeded');
    expect(fake.engine.interrupts).toBe(1);
    expect(fake.engine.unloads).toBe(0);

    await a.dispose();
    expect(fake.engine.unloads).toBe(0);
    await expectCompleted(b);
    await b.dispose();
    expect(fake.engine.unloads).toBe(0);
    await runtime.dispose();
    expect(fake.engine.unloads).toBe(0);
    expect(fake.worker.terminations).toBe(0);
    expect(fake.constructions).toBe(1);
    expect(fake.engine.reloads).toHaveLength(1);
    // Every call, including the cancelled one, closes before the next reset.
    expect(fake.engine.events).toEqual(
      Array.from({ length: 5 }, () => ['reset', 'create', 'closed']).flat(),
    );
    fake.engine.assertClosed();

    await handle.dispose();
    expect(fake.engine.unloads).toBe(1);
    expect(fake.worker.terminations).toBe(1);
    await handle.dispose();
    expect(fake.engine.unloads).toBe(1);
    expect(fake.worker.terminations).toBe(1);
  } finally {
    blocked.resolve();
    await runtime.dispose();
    await handle.dispose();
  }
});

test('two runtimes share one WebLLM handle after the first runtime is disposed', async () => {
  const fake = createFakeWebLLM();
  const handle = await createWebLLMEngine(
    { worker: fake.worker },
    { gpu: fake.gpu, loadModule: async () => fake.module },
  );
  const first = createTestRuntime();
  const second = createTestRuntime();
  try {
    const model = new WebLLMChatModel(handle);
    const a = await createConsumer(first, model);
    const b = await createConsumer(second, model);
    await expectCompleted(a);
    await expectCompleted(b);
    await first.dispose();
    expect(a.getSnapshot().state).toBe('disposed');
    expect(fake.engine.unloads).toBe(0);
    expect(fake.worker.terminations).toBe(0);
    await expectCompleted(b);
    await second.dispose();
    expect(fake.engine.unloads).toBe(0);
    expect(fake.constructions).toBe(1);
    expect(fake.engine.reloads).toHaveLength(1);
    expect(fake.engine.requests).toHaveLength(3);
    fake.engine.assertClosed();
    await handle.dispose();
    expect(fake.engine.unloads).toBe(1);
    expect(fake.worker.terminations).toBe(1);
  } finally {
    await first.dispose();
    await second.dispose();
    await handle.dispose();
  }
});

test('disposing one Built-in AI consumer destroys only its own in-flight session', async () => {
  const firstEntered = Promise.withResolvers<void>();
  const bothEntered = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  let calls = 0;
  const fake = new FakeLanguageModel({
    beforeNext: async (index) => {
      if (index === 1) {
        if (++calls === 1) firstEntered.resolve();
        else bothEntered.resolve();
        await blocked.promise;
      }
    },
  });
  const restore = installLanguageModel(fake);
  const runtime = createTestRuntime();
  try {
    const model = new BuiltInAIChatModel({ inputLanguages: ['en'], outputLanguages: ['en'] });
    const a = await createConsumer(runtime, model);
    const b = await createConsumer(runtime, model);
    const disposed = await a.start({});
    const disposedEvents = collect(a.events(disposed.runId));
    await firstEntered.promise;
    const surviving = await b.start({});
    await bothEntered.promise;
    expect(fake.sessions.map((session) => session.destroys)).toEqual([0, 0]);

    await a.dispose();
    expect((await disposedEvents).at(-1)?.type).toBe('cancelled');
    await vi.waitFor(() =>
      expect(fake.sessions.map((session) => session.destroys)).toEqual([1, 0]),
    );
    expect(fake.creates[0]?.signal?.aborted).toBe(true);
    expect(fake.creates[1]?.signal?.aborted).toBe(false);
    expect(b.getSnapshot().run?.status).toBe('running');

    blocked.resolve();
    expect((await collect(b.events(surviving.runId))).at(-1)).toMatchObject({
      type: 'output',
      output: { characters: 11 },
    });
    expect(b.getSnapshot().run?.status).toBe('succeeded');
    expect(fake.sessions.map((session) => session.destroys)).toEqual([1, 1]);
    await expectCompleted(b);
    expect(fake.sessions.map((session) => session.destroys)).toEqual([1, 1, 1]);
    await b.dispose();
    await runtime.dispose();
    expect(fake.sessions.map((session) => session.destroys)).toEqual([1, 1, 1]);
  } finally {
    blocked.resolve();
    await runtime.dispose();
    restore();
  }
});
