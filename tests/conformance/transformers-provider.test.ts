// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import {
  createRuntime,
  type DiagnosticEvent,
  defineAgentDefinition,
  type ModelRouting,
  type OutputSafetyHook,
  type Runtime,
} from '@galaxie/core';
import { MockChatModel } from '@galaxie/models/mock';
import {
  checkTransformersModel,
  loadTransformersEngine,
  type TransformersChatEngine,
  TransformersChatModel,
  type TransformersEngineHandle,
} from '@galaxie/models/transformers';
import { HumanMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { RunBudget } from '../../packages/core/src/budgets.js';
import { collect } from '../../packages/core/test/fake-executor.js';
import { recordNetwork } from '../../packages/core/test/network-recorder.js';
import { createSpanRecorder, serializeSpans } from '../../packages/core/test/span-tree.js';
import { modelCacheName } from '../../packages/models/src/transformers/model-record.js';
import type { FakeRuntimeOptions } from '../../packages/models/test/support/fake-transformers-runtime.js';
import { seed, setup } from '../../packages/models/test/support/transformers-loopback.js';
import {
  MemoryCacheStorage,
  type MemoryStore,
} from '../../packages/models/test/support/transformers-model.js';

const promptCanary = 'private prompt canary';
const state = Annotation.Root({ answer: Annotation<string> });
const definition = defineAgentDefinition({
  id: 'conformance/transformers',
  version: '1.0.0',
  executor: 'langgraph-js',
  input: z.object({}),
  models: { assistant: { modality: 'text' } },
});

let network: ReturnType<typeof recordNetwork>;
let nodeNetwork: ReturnType<typeof recordNetwork> | undefined;

beforeEach(async () => {
  // The same storage serves the availability probe and the Worker's verified store.
  vi.stubGlobal('caches', new MemoryCacheStorage());
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

interface Host {
  readonly parts: Awaited<ReturnType<typeof setup>>;
  readonly engine: TransformersChatEngine;
  /** Resolves the shared handle, loading it on first use. */
  handle(allowDownload: boolean): Promise<TransformersEngineHandle>;
  readonly routing: Pick<ModelRouting, 'availability' | 'download'>;
  readonly downloads: number[];
}

/** A host that loads the engine lazily: after a consented download, or from stored files. */
async function createHost(
  runtimeOptions: FakeRuntimeOptions,
  options: { cached: boolean; accept?: boolean } = { cached: false },
): Promise<Host> {
  const storage = globalThis.caches as unknown as MemoryCacheStorage;
  const { createSyntheticModel } = await import(
    '../../packages/models/test/support/transformers-model.js'
  );
  const model = await createSyntheticModel({ modelId: 'example-org/tiny-fixture' });
  const store = (await storage.open(modelCacheName(model.record))) as MemoryStore;
  if (options.cached) await seed(store, model);
  const parts = await setup({ model, runtime: runtimeOptions, store });
  let loading: Promise<TransformersEngineHandle> | undefined;
  const handle = (allowDownload: boolean): Promise<TransformersEngineHandle> => {
    loading ??= loadTransformersEngine({
      worker: parts.worker,
      model: model.record,
      allowDownload,
    }).catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };
  const downloads: number[] = [];
  const engine: TransformersChatEngine = {
    modelId: model.record.modelId,
    async *stream(request, signal) {
      yield* (await handle(false)).stream(request, signal);
    },
  };
  return {
    parts,
    engine,
    handle,
    downloads,
    routing: {
      availability: () => checkTransformersModel({ model: model.record }),
      download: async () => {
        downloads.push(1);
        if (options.accept !== true) return false;
        await handle(true);
        return true;
      },
    },
  };
}

type TestRuntime = Runtime<readonly [ReturnType<typeof createLangGraphAdapter>]>;

function createTestRuntime(options: { outputSafety?: OutputSafetyHook; tokens?: number } = {}) {
  const { exporter, provider } = createSpanRecorder();
  const diagnostics: DiagnosticEvent[] = [];
  const runtime: TestRuntime = createRuntime({
    appId: 'transformers-test',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    diagnostics: (event) => diagnostics.push(event),
    budgets: { tokens: options.tokens ?? 200 },
    ...(options.outputSafety === undefined ? {} : { outputSafety: options.outputSafety }),
  });
  return { runtime, exporter, provider, diagnostics };
}

async function createConsumer(
  runtime: TestRuntime,
  host: Host,
  options: {
    calls?: number;
    received?: string[];
    fallback?: MockChatModel;
    maxTokens?: number;
    engine?: TransformersChatEngine;
  } = {},
) {
  const received = options.received ?? [];
  const instance = await runtime.create(definition, {
    principalScope: 'transformers-test',
    services: {
      chatModels: {
        local: new TransformersChatModel(options.engine ?? host.engine),
        ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
      },
    },
    models: {
      providers: {
        local: {
          destination: 'in-browser',
          modality: 'text',
          features: ['streaming', 'cancellation'],
          pricing: { inputPerToken: 0, outputPerToken: 0 },
        },
        ...(options.fallback === undefined
          ? {}
          : {
              fallback: {
                destination: 'in-browser',
                modality: 'text',
                features: ['streaming', 'cancellation'],
                pricing: { inputPerToken: 0, outputPerToken: 0 },
              },
            }),
      },
      roles: {
        assistant: {
          providers: options.fallback === undefined ? ['local'] : ['local', 'fallback'],
          allow: ['in-browser'],
          maxTokens: options.maxTokens ?? 100,
        },
      },
      ...host.routing,
    },
    agent: (graphHost) =>
      new StateGraph(state)
        .addNode('respond', async (_state, config) => {
          let answer = '';
          for (let call = 0; call < (options.calls ?? 1); call++) {
            for await (const chunk of await graphHost.langchain
              .chatModel('assistant')
              .stream([new HumanMessage(promptCanary)], config)) {
              if (typeof chunk.content === 'string' && chunk.content) {
                received.push(chunk.content);
                answer += chunk.content;
              }
            }
          }
          return { answer };
        })
        .addEdge(START, 'respond')
        .addEdge('respond', END)
        .compile(),
  });
  await instance.prepare();
  return { instance, received };
}

function reservationCharges(): number[] {
  const charges: number[] = [];
  const originalReserve = RunBudget.prototype.reserveModel;
  vi.spyOn(RunBudget.prototype, 'reserveModel').mockImplementation(function (
    this: RunBudget,
    tokens,
    cost,
  ) {
    const reservation = originalReserve.call(this, tokens, cost);
    const index = charges.push(tokens) - 1;
    const { settle, release } = reservation;
    reservation.release = (): void => {
      charges[index] = 0;
      release();
    };
    reservation.settle = (chargedTokens, chargedCost): void => {
      charges[index] = chargedTokens;
      settle(chargedTokens, chargedCost);
    };
    return reservation;
  });
  return charges;
}

function expectNoCanary(records: unknown): void {
  const text = JSON.stringify(records);
  expect(text).not.toContain(promptCanary);
}

test('an uncached model asks to download; refusal fails denied and fetches nothing', async () => {
  const host = await createHost({}, { cached: false, accept: false });
  const { runtime, exporter, provider, diagnostics } = createTestRuntime();
  try {
    const { instance, received } = await createConsumer(runtime, host);
    const { runId } = await instance.start({});
    const events = await collect(instance.events(runId));
    await provider.forceFlush();
    expect(host.downloads).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'denied' } });
    expect(instance.getSnapshot().run?.status).toBe('failed');
    expect(received).toEqual([]);
    expect(host.parts.fetcher.calls).toEqual([]);
    expect(host.parts.runtime.loads).toEqual([]);
    expectNoCanary({
      events,
      diagnostics,
      snapshot: instance.getSnapshot(),
      spans: serializeSpans(exporter.getFinishedSpans()),
    });
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});

test('an accepted download loads with downloads allowed, re-probes available and answers', async () => {
  const host = await createHost({}, { cached: false, accept: true });
  const charges = reservationCharges();
  const { runtime, exporter, provider, diagnostics } = createTestRuntime();
  try {
    const { instance, received } = await createConsumer(runtime, host, { calls: 2 });
    const { runId } = await instance.start({});
    const events = await collect(instance.events(runId));
    await provider.forceFlush();
    expect(events.at(-1)).toMatchObject({
      type: 'output',
      output: { answer: 'Hello worldHello world' },
    });
    expect(received).toEqual(['Hello', ' world', 'Hello', ' world']);
    // One consented download served both calls; the second call found the files stored.
    expect(host.downloads).toHaveLength(1);
    expect(host.parts.fetcher.calls).toHaveLength(host.parts.model.urls.length);
    expect(host.parts.runtime.loads).toHaveLength(1);
    expect(instance.getSnapshot().routes?.['assistant']).toEqual({
      providerId: 'local',
      destination: 'in-browser',
    });
    // Actual usage (5 prompt + 2 completion tokens) settles each reservation.
    expect(charges).toEqual([7, 7]);
    const spans = serializeSpans(exporter.getFinishedSpans());
    expectNoCanary({ events, diagnostics, snapshot: instance.getSnapshot(), spans });
    // The reply text stays out of diagnostics and spans; raw stream events carry it by design.
    expect(JSON.stringify({ diagnostics, spans, snapshot: instance.getSnapshot() })).not.toContain(
      'Hello',
    );
    expect(diagnostics.map((event) => event.kind)).toEqual(['output_safety_unset']);
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});

test('stored files whose bytes differ fail unavailable without any fetch', async () => {
  const host = await createHost({}, { cached: true });
  // The size markers still say available, but the content no longer matches its hash.
  const store = (await (globalThis.caches as unknown as MemoryCacheStorage).open(
    modelCacheName(host.parts.model.record),
  )) as MemoryStore;
  const [first] = [...store.entries.values()];
  if (first === undefined) throw new Error('expected a stored file');
  first.bytes = first.bytes.map((byte) => byte ^ 0xff);
  const { runtime, exporter, provider, diagnostics } = createTestRuntime();
  try {
    const { instance, received } = await createConsumer(runtime, host);
    const { runId } = await instance.start({});
    const events = await collect(instance.events(runId));
    await provider.forceFlush();
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unavailable' } });
    expect(host.downloads).toEqual([]);
    expect(received).toEqual([]);
    expect(host.parts.fetcher.calls).toEqual([]);
    expect(host.parts.runtime.loads).toEqual([]);
    // The typed reason is the integrity failure, and still nothing was fetched.
    await expect(host.handle(false)).rejects.toMatchObject({
      code: 'unavailable',
      reason: 'integrity',
    });
    expect(host.parts.fetcher.calls).toEqual([]);
    expectNoCanary({
      events,
      diagnostics,
      snapshot: instance.getSnapshot(),
      spans: serializeSpans(exporter.getFinishedSpans()),
    });
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});

test('output safety blocking a growing chunk fails denied and withholds later chunks', async () => {
  const host = await createHost(
    { pieces: ['safe ', 'withheld-canary ', 'late '] },
    { cached: true },
  );
  const checked: string[] = [];
  const { runtime, provider } = createTestRuntime({
    outputSafety: ({ text }) => {
      checked.push(text);
      return text.includes('withheld-canary') ? 'block' : 'allow';
    },
  });
  try {
    const { instance, received } = await createConsumer(runtime, host);
    const { runId } = await instance.start({});
    const events = await collect(instance.events(runId));
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'denied' } });
    expect(instance.getSnapshot().run?.status).toBe('failed');
    expect(received).toEqual(['safe ']);
    expect(checked.some((text) => text.includes('late'))).toBe(false);
    expect(JSON.stringify(events)).not.toContain('withheld-canary');
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});

test('a missing usage report charges the reservation', async () => {
  const host = await createHost({}, { cached: true });
  const charges = reservationCharges();
  // A provider that never reports counts: the final `done` event is dropped.
  const silent: TransformersChatEngine = {
    modelId: host.engine.modelId,
    async *stream(request, signal) {
      for await (const event of host.engine.stream(request, signal))
        if (event.type === 'chunk') yield event;
    },
  };
  const { runtime, provider } = createTestRuntime();
  try {
    const { instance } = await createConsumer(runtime, host, { engine: silent });
    const { runId } = await instance.start({});
    const events = await collect(instance.events(runId));
    expect(events.at(-1)).toMatchObject({ type: 'output', output: { answer: 'Hello world' } });
    expect(charges).toEqual([100]);
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});

test('worker failure leaves the role failing unavailable and never retries elsewhere', async () => {
  const host = await createHost({}, { cached: true });
  const fallback = new MockChatModel({ [promptCanary]: { id: 'fallback', text: 'other model' } });
  const { runtime, provider } = createTestRuntime();
  try {
    const { instance, received } = await createConsumer(runtime, host, { fallback });
    // Loading from the stored files succeeds, then the Worker script dies.
    await host.handle(false);
    host.parts.worker.fail();
    const { runId } = await instance.start({});
    const events = await collect(instance.events(runId));
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unavailable' } });
    expect(received).toEqual([]);
    expect(instance.getSnapshot().routes?.['assistant']?.providerId).toBe('local');
    // The next run fails the same way: the handle stays failed and nothing else answers.
    const again = await instance.start({});
    expect((await collect(instance.events(again.runId))).at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'unavailable' },
    });
    expect(received).toEqual([]);
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});

test('disposing a runtime mid-call cancels it and leaves the shared handle for another runtime', async () => {
  const host = await createHost(
    { pieces: ['one ', 'two ', 'three'], holdAfter: 1 },
    { cached: true },
  );
  const first = createTestRuntime();
  const second = createTestRuntime();
  try {
    const a = await createConsumer(first.runtime, host);
    const started = await a.instance.start({});
    await vi.waitFor(() => expect(a.received).toEqual(['one ']));
    // Disposing the runtime while the call is in flight cancels it.
    const observed = collect(a.instance.events(started.runId));
    await first.runtime.dispose();
    expect((await observed).at(-1)?.type).toBe('cancelled');
    const handle = await host.handle(false);
    expect(host.parts.worker.terminated).toBe(0);
    // Another runtime answers from the same handle without a second load.
    const b = await createConsumer(second.runtime, host);
    const run = await b.instance.start({});
    const events = await collect(b.instance.events(run.runId));
    expect(events.at(-1)).toMatchObject({ type: 'output', output: { answer: 'one two three' } });
    expect(host.parts.runtime.loads).toHaveLength(1);
    await handle.dispose();
    expect(host.parts.worker.terminated).toBe(1);
  } finally {
    await first.runtime.dispose();
    await second.runtime.dispose();
    await first.provider.shutdown();
    await second.provider.shutdown();
  }
});
