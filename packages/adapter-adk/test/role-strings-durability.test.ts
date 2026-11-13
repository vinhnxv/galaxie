// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  type AgentInstance,
  type BudgetLimits,
  type CapabilityContext,
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  galaxieField,
  type ModelRouting,
  type RecoveryStore,
  type RunEvent,
  type SessionId,
} from '@galaxie-ai/core';
import { LlmAgent, type LlmRequest, LoopAgent, ParallelAgent, SequentialAgent } from '@google/adk';
import { AIMessage, type StandardMessageStructure } from '@langchain/core/messages';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { MemoryByteCheckpoints } from '../../../tests/conformance/support/memory-byte-checkpoints.js';
import { waitForRunStatus } from '../../../tests/conformance/support/run-status.js';
import { createSpanRecorder } from '../../core/test/span-tree.js';
import { MemoryRecoveryStore } from '../../core/test/support/memory-recovery-store.js';
import { IndexedDBSaver } from '../../storage-indexeddb/src/index.js';
import { type AdkAgent, adkToolset, createAdkAdapter, defineAdkEntry } from '../src/index.js';
import { FakeChatModel, wordChunks } from './support/fixtures.js';

const databases: string[] = [];
const prompt = 'inventory question';
const parameters = z.object({ q: z.string() });

afterEach(async () => {
  vi.restoreAllMocks();
  if (typeof indexedDB !== 'undefined')
    for (const name of databases.splice(0))
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
});

function sources(start: number): void {
  let next = start;
  let random = start;
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`,
  );
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  vi.spyOn(Math, 'random').mockImplementation(() => {
    random = (random * 16807) % 2147483647;
    return random / 2147483647;
  });
}

interface Store {
  readonly checkpoints: { request(value: unknown): Promise<unknown> };
  readonly recovery: RecoveryStore;
  close(): void;
}

function storage(name: string): { open(): Promise<Store> } {
  const checkpoints = new MemoryByteCheckpoints();
  const recovery = new MemoryRecoveryStore();
  return {
    async open() {
      if (typeof indexedDB === 'undefined') return { checkpoints, recovery, close() {} };
      if (!databases.includes(name)) databases.push(name);
      const saver = await IndexedDBSaver.open({
        databaseName: name,
        appId: 'adk-inventory-parity',
        principalScope: 'fixture',
      });
      return {
        checkpoints: saver.byteRecords,
        recovery: saver.recovery,
        close: () => saver.close(),
      };
    },
  };
}

async function decoded(store: Store, sessionId: SessionId): Promise<unknown[]> {
  const rows = (await store.checkpoints.request({
    op: 'list',
    executor: 'adk-js',
    sessionId,
    namespace: '',
    limit: 100,
  })) as Array<{
    checkpoint: { type: string; bytes: Uint8Array };
    metadata: { type: string; bytes: Uint8Array };
  }>;
  return rows.map(({ checkpoint, metadata, ...row }) => {
    const body = JSON.parse(new TextDecoder().decode(checkpoint.bytes)) as Record<string, unknown>;
    const state = JSON.parse(new TextDecoder().decode(metadata.bytes)) as Record<string, unknown>;
    delete state['key'];
    for (const event of body['events'] as Record<string, unknown>[]) {
      const custom = event['customMetadata'] as Record<string, unknown> | undefined;
      const stamps = custom?.['__adk_internal_fc_hmac'] as Record<string, unknown> | undefined;
      if (stamps !== undefined) for (const key of Object.keys(stamps)) stamps[key] = 'MAC';
    }
    return {
      ...row,
      checkpoint: { type: checkpoint.type, body },
      metadata: { type: metadata.type, body: state },
    };
  });
}

interface Variant {
  readonly strings: boolean;
  readonly grouped: boolean;
}

interface Scenario {
  readonly budgets?: Partial<BudgetLimits>;
  readonly blocked?: boolean;
  readonly remote?: boolean;
  readonly twice?: boolean;
  readonly longRunning?: 'sequential' | 'loop' | 'parallel';
}

function requestOf(request: LlmRequest): unknown {
  return structuredClone({
    contents: request.contents,
    system: request.config?.systemInstruction,
    tools: request.config?.tools,
  });
}

async function host(variant: Variant, store?: Store, scenario: Scenario = {}, adopted?: SessionId) {
  const requests: unknown[] = [];
  const checks: unknown[] = [];
  const effects: unknown[] = [];
  const writes: unknown[] = [];
  const recorder = createSpanRecorder();
  const usage = { input_tokens: 2, output_tokens: 2, total_tokens: 4 };
  const model = new FakeChatModel(
    (call) => {
      if (scenario.longRunning === 'sequential' && call.tools.length === 0)
        return new AIMessage<StandardMessageStructure>({
          id: 'prelude',
          content: 'first done',
          usage_metadata: usage,
        });
      const turns = call.messages.filter((message) => message.type === 'tool').length;
      if (turns < (scenario.twice === true ? 2 : 1))
        return new AIMessage<StandardMessageStructure>({
          id: `reply-${turns}`,
          content: '',
          tool_calls: [
            {
              id: `call_${turns}`,
              name: 'docs_save_1',
              args: { q: turns === 0 ? 'note' : 'other' },
            },
          ],
          usage_metadata: usage,
        });
      return new AIMessage<StandardMessageStructure>({
        id: 'answer',
        content: 'finished words',
        usage_metadata: usage,
      });
    },
    undefined,
    (message) => {
      const chunks = wordChunks(message);
      const last = chunks.at(-1);
      if (last !== undefined && message.usage_metadata !== undefined)
        last.usage_metadata = message.usage_metadata;
      return chunks;
    },
  );
  const adapter = createAdkAdapter();
  const observed: typeof adapter = {
    ...adapter,
    async prepare(...args) {
      const prepared = await adapter.prepare(...args);
      return {
        ...prepared,
        run(request) {
          const call = request.capabilities.call.bind(request.capabilities);
          vi.spyOn(request.capabilities, 'call').mockImplementation((name, input, options) => {
            effects.push({ name, input, scope: options?.effectScope });
            return call(name, input, options);
          });
          return prepared.run(request);
        },
      };
    },
  };
  const runtime = createRuntime({
    appId: 'adk-inventory-parity',
    executors: [observed as ExecutorAdapter<unknown, unknown>],
    tracerProvider: recorder.provider,
    budgets: { steps: 10, toolCalls: 10, tokens: 1000, ...scenario.budgets },
    outputSafety: ({ signal: _signal, ...check }) => {
      checks.push(check);
      return scenario.blocked === true ? 'block' : 'allow';
    },
  });
  const factory: AdkAgent = (host) => {
    const routed = host.adk.llm('answer');
    const generate = routed.generateContentAsync.bind(routed);
    routed.generateContentAsync = async function* (request, stream, signal) {
      requests.push(requestOf(request));
      yield* generate(request, stream, signal);
    };
    const tool = host.adk.capabilityTool('docs.save@1', {
      description: 'Save a note.',
      parameters,
      ...(store === undefined ? {} : { requireConfirmation: true }),
      ...(scenario.longRunning === undefined ? {} : { longRunning: true }),
    });
    const leaf = new LlmAgent({
      name: 'agent',
      model: variant.strings ? 'answer' : routed,
      instruction: 'Answer briefly.',
      tools: variant.grouped ? [adkToolset(host, [tool])] : [tool],
    });
    const first = new LlmAgent({
      name: 'first',
      model: variant.strings ? 'answer' : routed,
    });
    const agent =
      scenario.longRunning === 'sequential'
        ? new SequentialAgent({ name: 'root', subAgents: [first, leaf] })
        : scenario.longRunning === 'loop'
          ? new LoopAgent({ name: 'root', maxIterations: 1, subAgents: [leaf] })
          : scenario.longRunning === 'parallel'
            ? new ParallelAgent({ name: 'root', subAgents: [leaf] })
            : leaf;
    return defineAdkEntry({
      agent,
      ...(variant.strings ? { roleStrings: true as const } : {}),
      interaction: (pending) => ({
        surfaceId: 'main',
        viewRevision: 'r1',
        component: 'conformance.Approval/v1',
        props: { count: pending.length },
      }),
    });
  };
  const destination = scenario.remote === true ? 'third-party' : 'in-browser';
  const routing: ModelRouting = {
    providers: {
      mock: {
        destination,
        modality: 'text',
        languages: ['en'],
        features: ['tool-calling', 'streaming'],
        pricing: { inputPerToken: 0, outputPerToken: 0 },
      },
    },
    roles: { answer: { providers: ['mock'], allow: [destination], maxTokens: 20 } },
    consent: async () => true,
  };
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'tests/adk-inventory-parity',
      version: '1.0.0',
      executor: 'adk-js',
      input: z.object({ prompt: z.string().meta(galaxieField({ label: 'private-user' })) }),
      models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'remote-allowed' } },
      capabilities: {
        required: {
          'docs.save@1': {
            kind: store === undefined ? 'read' : 'write',
            input: parameters,
            output: z.object({ saved: z.string() }),
          },
        },
      },
    }),
    {
      principalScope: 'fixture',
      ...(adopted === undefined ? {} : { sessionId: adopted }),
      ...(store === undefined ? {} : { recovery: store.recovery }),
      confirmations: { capabilities: ['docs.save@1'], policyRevision: () => 'inventory-v1' },
      agent: factory,
      services: {
        chatModels: { mock: model },
        ...(store === undefined ? {} : { checkpoints: store.checkpoints }),
      },
      bindings: {
        'docs.save@1': {
          kind: store === undefined ? 'read' : 'write',
          destination: 'in-browser',
          timeoutMs: 1000,
          concurrency: 1,
          grantScope: 'instance',
          approval: store === undefined ? 'none' : 'confirm',
          retry: 'none',
          async invoke(input: { q: string }, context: CapabilityContext) {
            writes.push({ input, effectId: context.effectId });
            return { saved: input.q };
          },
        },
      },
      models: routing,
    },
  );
  await instance.prepare();
  const timer = setInterval(() => {
    for (const pending of instance.getSnapshot().confirmations ?? [])
      instance.respond(pending.id, 'approve');
  }, 1);
  return {
    runtime,
    instance,
    requests,
    checks,
    effects,
    writes,
    model,
    spans: () =>
      recorder.exporter
        .getFinishedSpans()
        .map((span) => ({ name: span.name, attributes: span.attributes, status: span.status })),
    async close() {
      clearInterval(timer);
      await runtime.dispose();
      await recorder.provider.shutdown();
    },
  };
}

async function readEvents(
  instance: AgentInstance<unknown, unknown>,
  runId: Parameters<AgentInstance<unknown, unknown>['events']>[0],
  paused = false,
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of instance.events(runId)) {
    events.push(event);
    if (paused && event.type === 'interaction') break;
  }
  return events;
}

async function reload(variant: Variant, name: string) {
  const source = storage(name);
  const observations: unknown[] = [];
  let pending: unknown;
  let adopted: SessionId | undefined;
  for (const resumed of [false, true]) {
    sources(resumed ? 1000 : 1);
    const store = await source.open();
    const current = await host(variant, store, {}, adopted);
    try {
      const run = resumed
        ? await current.instance.restore()
        : await current.instance.start({ prompt });
      expect(run).toBeDefined();
      await waitForRunStatus(current.instance, 'waiting_input');
      const waiting = current.instance.getSnapshot().run;
      expect(waiting?.pending).toBeDefined();
      if (resumed) expect(waiting?.pending).toEqual(pending);
      else {
        pending = waiting?.pending;
        adopted = current.instance.sessionId;
      }
      if (resumed && waiting?.pending !== undefined && run !== undefined) {
        const receipt = await current.instance.dispatch({
          instanceId: current.instance.instanceId,
          runId: run.runId,
          ...waiting.pending,
          action: 'approve',
          payload: { indexes: [0] },
        });
        expect(receipt.status).toBe('accepted');
        await waitForRunStatus(current.instance, 'succeeded');
        expect(current.writes).toHaveLength(1);
      } else expect(current.writes).toEqual([]);
      if (run === undefined) throw new Error('The run is missing.');
      observations.push({
        records: await decoded(store, current.instance.sessionId),
        events: await readEvents(current.instance, run.runId, !resumed),
        requests: current.requests,
        checks: current.checks,
        effects: current.effects,
        writes: current.writes,
        labels: current.instance.getSnapshot().run?.labels,
        routes: current.instance.getSnapshot().routes,
        calls: current.model.seen.length,
        limits: current.model.seen.map((call) => call.options['maxTokens']),
        spans: current.spans(),
      });
    } finally {
      await current.close();
      store.close();
      vi.restoreAllMocks();
    }
  }
  return observations;
}

test('mapped models and fixed toolsets preserve complete records and effects across confirmation reload', async () => {
  const control = await reload({ strings: false, grouped: false }, 'inventory-control');
  expect(await reload({ strings: true, grouped: false }, 'inventory-strings')).toEqual(control);
  expect(await reload({ strings: false, grouped: true }, 'inventory-toolset')).toEqual(control);
  expect(await reload({ strings: true, grouped: true }, 'inventory-combined')).toEqual(control);
}, 900000);

async function run(variant: Variant, scenario: Scenario = {}) {
  sources(1);
  const current = await host(variant, undefined, scenario);
  try {
    const started = await current.instance.start({ prompt });
    const events = await readEvents(current.instance, started.runId);
    return {
      events,
      requests: current.requests,
      checks: current.checks,
      effects: current.effects,
      writes: current.writes,
      run: current.instance.getSnapshot().run,
      routes: current.instance.getSnapshot().routes,
      calls: current.model.seen.length,
      limits: current.model.seen.map((call) => call.options['maxTokens']),
      spans: current.spans(),
    };
  } finally {
    await current.close();
    vi.restoreAllMocks();
  }
}

test.each([
  { name: 'ordinary', scenario: {}, calls: 2, writes: 1, code: undefined },
  {
    name: 'steps',
    scenario: { budgets: { steps: 1 } },
    calls: 1,
    writes: 1,
    code: 'budget_exceeded',
  },
  {
    name: 'reported tokens',
    scenario: { budgets: { tokens: 24 }, twice: true },
    calls: 2,
    writes: 2,
    code: 'budget_exceeded',
  },
  {
    name: 'tool calls',
    scenario: { budgets: { toolCalls: 1 }, twice: true },
    calls: 2,
    writes: 1,
    code: 'budget_exceeded',
  },
  { name: 'output checks', scenario: { blocked: true }, calls: 1, writes: 0, code: 'denied' },
  { name: 'private destination', scenario: { remote: true }, calls: 0, writes: 0, code: 'denied' },
])(
  '$name accounting labels checks and ordered streams match the helper-built control',
  async ({ scenario, calls, writes, code }) => {
    const control = await run({ strings: false, grouped: false }, scenario);
    expect(control.calls).toBe(calls);
    expect(control.writes).toHaveLength(writes);
    expect(control.run?.labels).toContain('private-user');
    if (code === undefined) {
      expect(control.events.at(-1)).toMatchObject({ type: 'output', output: 'finished words' });
      expect(control.events.some((event) => event.type === 'stream')).toBe(true);
      expect(control.checks.length).toBeGreaterThan(0);
      expect(control.limits).toEqual([20, 20]);
    } else expect(control.events.at(-1)).toMatchObject({ type: 'error', error: { code } });
    for (const variant of [
      { strings: true, grouped: false },
      { strings: false, grouped: true },
      { strings: true, grouped: true },
    ])
      expect(await run(variant, scenario)).toEqual(control);
  },
  900000,
);

test.each(['sequential', 'loop', 'parallel'] as const)(
  'long-running fixed tools retain the %s pause refusal and flat-list effect scope',
  async (longRunning) => {
    const control = await run({ strings: false, grouped: false }, { longRunning });
    expect(control.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
    expect(control.effects).toHaveLength(1);
    expect(control.writes).toHaveLength(1);
    expect(await run({ strings: false, grouped: true }, { longRunning })).toEqual(control);
    expect(await run({ strings: true, grouped: true }, { longRunning })).toEqual(control);
  },
  900000,
);
