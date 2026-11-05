// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import '../../packages/adapter-adk/test/support/adk-env.js';
import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import {
  createRuntime,
  type DiagnosticEvent,
  defineAgentDefinition,
  type ExecutorAdapter,
  type ModelFeature,
  type ModelRouting,
  type OutputSafetyHook,
  type RunEvent,
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
import { LlmAgent } from '@google/adk';
import { HumanMessage } from '@langchain/core/messages';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { type AdkHost, createAdkAdapter } from '../../packages/adapter-adk/src/index.js';
import { outputText } from '../../packages/adapter-adk/src/tool-calls.js';
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
import { toolCallChecks } from './support/tool-call-checks.js';

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
  options: { cached: boolean; accept?: boolean; toolFormat?: 'hermes' } = { cached: false },
): Promise<Host> {
  const storage = globalThis.caches as unknown as MemoryCacheStorage;
  const { createSyntheticModel } = await import(
    '../../packages/models/test/support/transformers-model.js'
  );
  const model = await createSyntheticModel({
    modelId: 'example-org/tiny-fixture',
    ...(options.toolFormat === undefined ? {} : { toolFormat: options.toolFormat }),
  });
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
    toolFormat: model.record.toolFormat,
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

// Tool calling is routed through the ADK adapter's model: the LangGraph routed model has no
// `bindTools`. The reply text and the call arguments pass the router's output check either way.

const toolDefinition = defineAgentDefinition({
  id: 'conformance/transformers-tools',
  version: '1.0.0',
  executor: 'adk-js',
  input: z.object({ prompt: z.string() }),
  models: { assistant: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  capabilities: {
    required: {
      'docs.search@1': {
        kind: 'read',
        input: z.object({ q: z.string() }),
        output: z.object({ hit: z.string() }),
      },
    },
  },
});

const block = (name: string, args: unknown): string =>
  `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

async function runWithTools(
  host: Host,
  outputSafety: OutputSafetyHook = () => 'allow',
): Promise<{
  events: RunEvent[];
  searched: unknown[];
  checked: string[];
  dispose(): Promise<void>;
}> {
  const checked: string[] = [];
  const runtime = createRuntime({
    appId: 'transformers-tools-test',
    executors: [createAdkAdapter() as ExecutorAdapter<unknown, unknown>],
    budgets: { steps: 8, toolCalls: 10, tokens: 5000 },
    outputSafety: (input) => {
      checked.push(input.text);
      return outputSafety(input);
    },
  });
  const searched: unknown[] = [];
  const instance = await runtime.create(toolDefinition, {
    principalScope: 'transformers-test',
    agent: (adkHost: AdkHost) =>
      new LlmAgent({
        name: 'agent',
        model: adkHost.adk.llm('assistant'),
        instruction: 'Answer briefly.',
        tools: [
          adkHost.adk.capabilityTool('docs.search@1', {
            toolName: 'lookup',
            description: 'Search the documents.',
            parameters: z.object({ q: z.string() }),
          }),
        ],
      }),
    services: { chatModels: { local: new TransformersChatModel(host.engine) } },
    bindings: {
      'docs.search@1': {
        kind: 'read',
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 1,
        grantScope: 'instance',
        approval: 'none',
        retry: 'none',
        async invoke(input: { q: string }) {
          searched.push(input);
          return { hit: `found ${input.q}` };
        },
      },
    },
    models: {
      providers: {
        local: {
          destination: 'in-browser',
          modality: 'text',
          languages: ['en'],
          features: ['streaming', 'cancellation', 'tool-calling'],
          pricing: { inputPerToken: 0, outputPerToken: 0 },
        },
      },
      roles: { assistant: { providers: ['local'], allow: ['in-browser'], maxTokens: 100 } },
      ...host.routing,
    },
  });
  await instance.prepare();
  const { runId } = await instance.start({ prompt: promptCanary });
  const events = await collect(instance.events(runId));
  return { events, searched, checked, dispose: () => runtime.dispose() };
}

test('a routed tool call runs the capability and the next request replays the call and result', async () => {
  const host = await createHost(
    {
      scripts: [
        ['Checking. ', block('lookup', { q: 'x' })],
        ['It is ', 'found.'],
      ],
    },
    { cached: true, toolFormat: 'hermes' },
  );
  const charges = reservationCharges();
  const run = await runWithTools(host);
  try {
    expect(run.events.at(-1)).toMatchObject({ type: 'output' });
    expect(run.searched).toEqual([{ q: 'x' }]);
    const [first, second] = host.parts.runtime.generations;
    expect(first?.request.tools).toMatchObject([
      { type: 'function', function: { name: 'lookup', description: 'Search the documents.' } },
    ]);
    // The second request holds the assistant call and the capability result, in order.
    const roles = second?.request.messages.map((message) => message.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(second?.request.messages.at(2)).toMatchObject({
      role: 'assistant',
      toolCalls: [{ name: 'lookup', arguments: { q: 'x' } }],
    });
    expect(second?.request.messages.at(3)?.content).toContain('found x');
    // Each call is charged its actual usage: 5 prompt tokens plus one token per piece.
    expect(charges).toEqual([7, 7]);
    expect(run.checked.some((text) => text.includes('"q":"x"'))).toBe(true);
  } finally {
    await run.dispose();
  }
});

test('two blocks in one reply run both calls in order', async () => {
  const host = await createHost(
    {
      scripts: [[block('lookup', { q: 'a' }), block('lookup', { q: 'b' })], ['done']],
    },
    { cached: true, toolFormat: 'hermes' },
  );
  const run = await runWithTools(host);
  try {
    expect(run.events.at(-1)).toMatchObject({ type: 'output', output: 'done' });
    expect(run.searched).toEqual([{ q: 'a' }, { q: 'b' }]);
    const toolTurn = host.parts.runtime.generations[1]?.request.messages.at(2);
    expect(toolTurn?.toolCalls?.map((call) => call.arguments)).toEqual([{ q: 'a' }, { q: 'b' }]);
  } finally {
    await run.dispose();
  }
});

test.each([
  ['truncated JSON', '<tool_call>{"name": "lookup", "arguments": {"q": "x"'],
  ['text that is not JSON', '<tool_call>not json</tool_call>'],
  ['JSON with string arguments', '<tool_call>{"name": "lookup", "arguments": "x"}</tool_call>'],
  ['JSON with array arguments', '<tool_call>{"name": "lookup", "arguments": [1]}</tool_call>'],
  ['JSON without a name', '<tool_call>{"arguments": {"q": "x"}}</tool_call>'],
])(
  'a malformed block (%s) fails the streamed call invalid and runs no capability',
  async (_label, reply) => {
    const host = await createHost({ scripts: [[reply]] }, { cached: true, toolFormat: 'hermes' });
    const run = await runWithTools(host);
    try {
      expect(run.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'invalid' } });
      expect(run.searched).toEqual([]);
      expect(host.parts.runtime.generations).toHaveLength(1);
    } finally {
      await run.dispose();
    }
  },
);

test('a block verdict on well-formed call arguments fails denied and runs no capability', async () => {
  const host = await createHost(
    { scripts: [[block('lookup', { q: 'secret-arg' })]] },
    { cached: true, toolFormat: 'hermes' },
  );
  const run = await runWithTools(host, ({ text }) =>
    text.includes('secret-arg') ? 'block' : 'allow',
  );
  try {
    expect(run.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'denied' } });
    expect(run.searched).toEqual([]);
  } finally {
    await run.dispose();
  }
});

test('a record without a tool format fails the routed tool call unsupported before any request', async () => {
  const host = await createHost({ scripts: [['unused']] }, { cached: true });
  const run = await runWithTools(host);
  try {
    expect(run.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
    expect(host.parts.runtime.generations).toEqual([]);
  } finally {
    await run.dispose();
  }
});

// The shared table covers replies that carry provider mirrors this provider never produces, so
// only the cases a text-format reply can express are compared.
test.each([
  ['text', 'hello'],
  ['two calls', `hello\n${block('lookup', { value: 2 })}\n${block('lookup', { value: 3 })}`],
  ['invalid arguments', '<tool_call>{"value":</tool_call>'],
])('the checked text for a %s reply matches the shared case table', async (name, reply) => {
  const host = await createHost({ scripts: [[reply]] }, { cached: true, toolFormat: 'hermes' });
  const model = new TransformersChatModel(host.engine).bindTools([
    {
      type: 'function',
      function: { name: 'lookup', description: 'Look up.', parameters: { type: 'object' } },
    },
  ]);
  try {
    const message = await model.invoke('go');
    const expected = toolCallChecks.find((check) => check.name === name)?.checked;
    expect(expected).toBeDefined();
    expect(outputText(message)).toBe(expected);
  } finally {
    await (await host.handle(false)).dispose();
  }
});

const structuredSchema = z.object({ answer: z.literal('yes') });

async function runStructured(
  host: Host,
  options: { features?: readonly ModelFeature[]; repairAttempts?: number } = {},
) {
  const { runtime, provider, diagnostics } = createTestRuntime();
  try {
    const instance = await runtime.create(definition, {
      principalScope: 'transformers-test',
      services: { chatModels: { local: new TransformersChatModel(host.engine) } },
      models: {
        providers: {
          local: {
            destination: 'in-browser',
            modality: 'text',
            features: options.features ?? ['streaming', 'cancellation', 'structured-output'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: {
          assistant: {
            providers: ['local'],
            allow: ['in-browser'],
            maxTokens: 100,
            ...(options.repairAttempts === undefined
              ? {}
              : { repairAttempts: options.repairAttempts }),
          },
        },
        ...host.routing,
      },
      agent: (graphHost) =>
        new StateGraph(Annotation.Root({ answer: Annotation<string> }))
          .addNode('respond', async (_state, config) => {
            const parsed = await graphHost.langchain
              .chatModel('assistant')
              .withStructuredOutput(structuredSchema)
              .invoke([new HumanMessage(promptCanary)], config);
            return { answer: parsed.answer };
          })
          .addEdge(START, 'respond')
          .addEdge('respond', END)
          .compile(),
    });
    await instance.prepare();
    const { runId } = await instance.start({});
    const events = await collect(instance.events(runId));
    await provider.forceFlush();
    return { events, snapshot: instance.getSnapshot(), diagnostics };
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
}

test('routed structured output sends the schema to the runtime and returns the parsed object', async () => {
  const host = await createHost({ pieces: ['{"answer":', '"yes"}'] }, { cached: true });
  const result = await runStructured(host);
  expect(result.events.at(-1)).toMatchObject({ type: 'output', output: { answer: 'yes' } });
  expect(host.parts.runtime.generations).toHaveLength(1);
  expect(host.parts.runtime.generations[0]?.request.jsonSchema).toEqual(
    toJsonSchema(structuredSchema),
  );
  expect(JSON.stringify(result.snapshot)).not.toContain(promptCanary);
});

test('a reply that breaks the schema fails invalid with the fixed message and no reply text', async () => {
  const host = await createHost(
    { pieces: ['{"answer":"private reply canary"}'] },
    { cached: true },
  );
  const result = await runStructured(host);
  expect(result.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'invalid' } });
  // Raw stream events carry the reply by design; the failure, snapshot and diagnostics do not.
  expect(JSON.stringify([result.events.at(-1), result.snapshot, result.diagnostics])).not.toContain(
    'private reply canary',
  );
  expect(host.parts.runtime.generations).toHaveLength(1);
});

test('with repairAttempts set a broken reply is repaired through an ordinary second call', async () => {
  const host = await createHost(
    { scripts: [['{"answer":"no"}'], ['{"answer":"yes"}']] },
    { cached: true },
  );
  const result = await runStructured(host, { repairAttempts: 1 });
  expect(result.events.at(-1)).toMatchObject({ type: 'output', output: { answer: 'yes' } });
  expect(host.parts.runtime.generations).toHaveLength(2);
  expect(host.parts.runtime.generations.every((g) => g.request.jsonSchema !== undefined)).toBe(
    true,
  );
});

test('a descriptor without structured-output is not selected: the call fails unavailable before dispatch', async () => {
  const host = await createHost({ pieces: ['{"answer":"yes"}'] }, { cached: true });
  const result = await runStructured(host, { features: ['streaming', 'cancellation'] });
  expect(result.snapshot.run).toMatchObject({ status: 'failed', error: { code: 'unavailable' } });
  expect(host.parts.runtime.generations).toEqual([]);
});
