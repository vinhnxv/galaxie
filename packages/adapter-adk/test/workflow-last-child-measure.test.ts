// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  type CapabilityContext,
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  type ModelRouting,
  type RunEvent,
  type SessionId,
} from '@galaxie-ai/core';
import { type BaseAgent, LlmAgent, LoopAgent, ParallelAgent, SequentialAgent } from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { MemoryByteCheckpoints } from '../../../tests/conformance/support/memory-byte-checkpoints.js';
import { waitForRunStatus } from '../../../tests/conformance/support/run-status.js';
import { MemoryRecoveryStore } from '../../core/test/support/memory-recovery-store.js';
import { IndexedDBSaver } from '../../storage-indexeddb/src/index.js';
import { createAdkAdapter } from '../src/adapter.js';
import type { AdkHost } from '../src/host.js';
import { defineAdkEntry } from '../src/interaction.js';
import { createCandidateAdapter, resumed } from './support/candidate-adapter.js';
import { FakeChatModel, type Reply } from './support/fixtures.js';

/* Scripted ADK 2.3.0, Node and Chromium, with local Firefox/WebKit measurements. PASS/FAIL are gate verdicts;
 * the tests pin both favourable observations and the literal failing evidence.
 * Native N1-N3 reuse workflow-resume-native.test.ts (L1-L5) and
 * workflow-last-child-native.test.ts (L6-L9), without duplicating their runs.
 * Shape   N1    N2    N3            G0    G1    G2    G3             G4    G5
 * L1      PASS  PASS  PASS          PASS  PASS  PASS  PASS           PASS  PASS
 * L2      PASS  PASS  PASS          PASS  PASS  PASS  NA: deny/zero  PASS  PASS
 * L3      PASS  PASS  PASS          PASS  PASS  PASS  PASS           PASS  PASS
 * L4      PASS  PASS  PASS          PASS  PASS  PASS  FAIL           PASS  PASS
 * L5      PASS  PASS  PASS          PASS  FAIL  PASS  PASS           PASS  PASS
 * L6      PASS  PASS  PASS          PASS  PASS  PASS  PASS           PASS  PASS
 * L7      PASS  PASS  PASS          PASS  PASS  PASS  PASS           PASS  PASS
 * L8      PASS  PASS  NA: no state  PASS  PASS  PASS  PASS           PASS  PASS
 * L9      PASS  PASS  PASS          PASS  PASS  PASS  PASS           PASS  PASS
 * G0: shipped-policy substitution and normal candidate equal shipped C1-C4;
 * controls never select the resumable Runner, each in-place resume selects it
 * once. G5's C1-C4 and all R1-R10 (including four R6 parallel trees) PASS under
 * both adapters. Other L-shape G5 cells cite those same shared refusal controls.
 * G1 L5 FAIL: its long-running body invokes b before the external ADK answer,
 * as native does; the separate host confirmation is still required and checked.
 * L8's earlier ordinary writer runs only after its own host confirmation; no b
 * body runs before the b interaction answer. All live transcript parity holds.
 * G2 reopens memory on Node and real IndexedDB in each browser at EVERY pause,
 * including L4's second, with the same pending ID and no restore dispatch.
 * G3 L4 FAIL: live and failed-write/replay scopes are root/0/0, root/2/0;
 * uninterrupted scopes are root/0/0, root/1/0. Only conversation ID is normalized.
 * The earlier confirmation-request event advances the existing function-call ordinal.
 * Actual host bodies still run twice total and never repeat on automatic replay.
 * Failure/replay is measured for L1/L4/L5/L8; L2 G3 is NA because deny runs no body.
 * G4: all ten changes for EACH stored shape PASS, including the older executor,
 * forged workflow markers, missing history and L4's second pause. Repeated failed
 * restore precedes data registration and changes neither rows nor write markers.
 * The inherited G4 last source stays unchanged and is also tested on candidate.
 * Shipped L1-L9 refusal observations PASS as current-behaviour controls; their
 * G2/G3 continuations are NA because no interaction/checkpoint exists to resume.
 * Outcome mapping applied once after every Node/Chromium gate: REFUSED because
 * L4 is a base shape and fails G3 (ADR-0020, "Last-child rerun"). Scope-equality
 * and universal-pass predictions miss; all literal native request orders hold.
 * Firefox/WebKit local runs reproduce these same gate verdicts. The older native
 * L1-L5 file is cited from Node/Chromium; the new native variants ran on all four engines.
 * Real models, network providers and device behaviour remain UNMEASURED.
 */

type Tree =
  | string
  | { seq: Tree[] }
  | { loop: Tree[] }
  | { par: Tree[] }
  | { transfer: Tree; name?: string };
interface Shape {
  id: string;
  tree: Tree;
  paused: string[];
  deny?: boolean;
  twice?: boolean;
  long?: boolean;
  rightFirst?: boolean;
  temporary?: boolean;
  twoCalls?: boolean;
  persistent?: boolean;
}
type AdapterFactory = () => ReturnType<typeof createAdkAdapter>;
const controls: Shape[] = [
  { id: 'C1', tree: { seq: ['first', 'second'] }, paused: ['first'] },
  { id: 'C2', tree: { seq: [{ seq: ['inner', 'b'] }, 'c'] }, paused: ['inner'] },
  { id: 'C3', tree: { transfer: 'child' }, paused: ['child'] },
  { id: 'C4', tree: 'solo', paused: ['solo'] },
];

const shapes: Shape[] = [
  { id: 'L1', tree: { seq: ['a', 'b'] }, paused: ['b'] },
  { id: 'L2', tree: { seq: ['a', 'b'] }, paused: ['b'], deny: true },
  { id: 'L3', tree: { seq: ['a', { seq: ['b', 'c'] }] }, paused: ['c'] },
  { id: 'L4', tree: { seq: ['a', 'b'] }, paused: ['b'], twice: true },
  { id: 'L5', tree: { seq: ['a', 'b'] }, paused: ['b'], long: true },
  { id: 'L6', tree: { seq: ['a', { seq: ['b', { seq: ['c', 'd'] }] }] }, paused: ['d'] },
  { id: 'L7', tree: { seq: ['a', 'b'] }, paused: ['b'], twoCalls: true },
  { id: 'L8', tree: { seq: ['writer', 'b'] }, paused: ['b'] },
  { id: 'L9', tree: { seq: ['a', 'b'] }, paused: ['b'], persistent: true },
];

// Literal observations from workflow-resume-native.test.ts and
// workflow-last-child-native.test.ts, using ADK's own resumable Runner.
const native: Record<
  string,
  { requests: string[]; writes: string[]; pauses: number; output: string }
> = {
  L1: { requests: ['a', 'b', 'b'], writes: ['b'], pauses: 1, output: 'b:done' },
  L2: { requests: ['a', 'b', 'b'], writes: [], pauses: 1, output: 'b:done' },
  L3: { requests: ['a', 'b', 'c', 'c'], writes: ['c'], pauses: 1, output: 'c:done' },
  L4: { requests: ['a', 'b', 'b', 'b'], writes: ['b', 'b'], pauses: 2, output: 'b:done' },
  L5: { requests: ['a', 'b', 'b'], writes: ['b'], pauses: 1, output: 'b:done' },
  L6: { requests: ['a', 'b', 'c', 'd', 'd'], writes: ['d'], pauses: 1, output: 'd:done' },
  L7: { requests: ['a', 'b', 'b'], writes: ['b:0', 'b:1'], pauses: 1, output: 'b:done' },
  L8: {
    requests: ['writer', 'writer', 'b', 'b'],
    writes: ['writer', 'b'],
    pauses: 1,
    output: 'b:done',
  },
  L9: { requests: ['a', 'b', 'b'], writes: ['b'], pauses: 1, output: 'b:done' },
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function leaves(tree: Tree): string[] {
  if (typeof tree === 'string') return [tree];
  if ('seq' in tree) return tree.seq.flatMap(leaves);
  if ('loop' in tree) return tree.loop.flatMap(leaves);
  if ('par' in tree) return tree.par.flatMap(leaves);
  return leaves(tree.transfer);
}

const routing: ModelRouting = {
  providers: {
    mock: {
      destination: 'in-browser',
      modality: 'text',
      languages: ['en'],
      features: ['tool-calling'],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: { agent: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
};
const definition = defineAgentDefinition({
  id: 'tests/adk-last-child-resume',
  version: '1.0.0',
  executor: 'adk-js',
  input: z.object({ prompt: z.string() }),
  models: { agent: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  capabilities: {
    required: {
      'docs.save@1': {
        kind: 'write',
        input: z.object({ q: z.string() }),
        output: z.object({ saved: z.string() }),
      },
    },
  },
});

async function source() {
  const bytes = new MemoryByteCheckpoints();
  const journal = new MemoryRecoveryStore();
  const name = `adk-last-child-${crypto.randomUUID()}`;
  return {
    bytes,
    journal,
    async open() {
      if (typeof indexedDB === 'undefined')
        return { checkpoints: bytes, recovery: journal, close() {} };
      const saver = await IndexedDBSaver.open({
        databaseName: name,
        appId: 'last-child-spike',
        principalScope: 'user',
      });
      return {
        checkpoints: saver.byteRecords,
        recovery: saver.recovery,
        close: () => saver.close(),
      };
    },
    async remove() {
      if (typeof indexedDB !== 'undefined')
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
    },
  };
}
type Store = Awaited<ReturnType<Awaited<ReturnType<typeof source>>['open']>>;

async function life(
  shape: Shape,
  store: Store,
  adapterFactory: AdapterFactory,
  options: {
    sessionId?: SessionId;
    crash?: boolean;
    crashAfter?: number;
    ungated?: boolean;
    duplicatePrepare?: boolean;
  } = {},
) {
  const requests: string[] = [];
  const writes: string[] = [];
  const effects: string[] = [];
  const scopes: string[] = [];
  const capabilities: string[] = [];
  const registrations: unknown[] = [];
  const approvals = new Set<string>();
  const cursors = new Map<string, number>();
  let muted = false;
  const turns = new Map<string, number>();
  const rightFinished = Promise.withResolvers<void>();
  const reply: Reply = async (seen) => {
    const tag =
      /role=(\w+);/.exec(
        JSON.stringify(seen.messages.find((message) => message.type === 'system')?.content),
      )?.[1] ?? '';
    requests.push(tag);
    if (muted) return new AIMessage({ content: `${tag}:fresh` });
    const turn = turns.get(tag) ?? 0;
    turns.set(tag, turn + 1);
    const answered = seen.messages.filter(
      (message) =>
        message.type === 'tool' &&
        (message.name === `save_${tag}` || message.name?.startsWith(`save_${tag}_`)),
    ).length;
    if (options.crash && answered >= (options.crashAfter ?? 1))
      throw new Error('Scripted failure after approved write.');
    if (shape.rightFirst && tag === 'left') await rightFinished.promise;
    if (shape.rightFirst && tag === 'right' && answered > 0)
      setTimeout(() => rightFinished.resolve(), 0);
    const call =
      tag === 'parent'
        ? { name: 'transfer_to_agent', args: { agent_name: 'child' } }
        : shape.paused.includes(tag) && answered < (shape.twice ? 2 : 1)
          ? { name: `save_${tag}`, args: { q: tag } }
          : (tag === 'writer' && turn % 2 === 0) ||
              (tag === 'right' && turn === 0 && !shape.paused.includes(tag))
            ? { name: `save_${tag}`, args: { q: tag } }
            : undefined;
    return call === undefined
      ? new AIMessage({ content: tag === 'a' ? 'value-a' : `${tag}:done` })
      : new AIMessage({
          content: '',
          tool_calls:
            shape.twoCalls && tag === 'b'
              ? [0, 1].map((index) => ({
                  id: `call_${index}`,
                  name: `save_b_${index}`,
                  args: { q: `b:${index}` },
                }))
              : [{ id: 'call_0', ...call }],
        });
  };
  const build = (host: AdkHost): BaseAgent => {
    let serial = 0;
    const node = (tree: Tree): BaseAgent => {
      if (typeof tree !== 'string') {
        const name = `flow_${serial++}`;
        if ('seq' in tree) return new SequentialAgent({ name, subAgents: tree.seq.map(node) });
        if ('loop' in tree)
          return new LoopAgent({ name, maxIterations: 2, subAgents: tree.loop.map(node) });
        if ('par' in tree) return new ParallelAgent({ name, subAgents: tree.par.map(node) });
        return new LlmAgent({
          name: tree.name ?? 'parent',
          instruction: `role=${tree.name ?? 'parent'};`,
          model: host.adk.llm('agent'),
          subAgents: [node(tree.transfer)],
        });
      }
      return new LlmAgent({
        name: tree,
        instruction: `role=${tree};${shape.persistent ? ' persistent={saved?};' : ''}`,
        model: host.adk.llm('agent'),
        tools: (shape.twoCalls && tree === 'b' ? [0, 1] : [0]).map((index) =>
          host.adk.capabilityTool('docs.save@1', {
            toolName: `save_${tree}${shape.twoCalls && tree === 'b' ? `_${index}` : ''}`,
            description: 'Save one scripted note.',
            parameters: z.object({ q: z.string() }),
            ...(shape.paused.includes(tree) && !options.ungated
              ? shape.long
                ? { longRunning: true }
                : { requireConfirmation: true }
              : {}),
          }),
        ),
        ...(shape.temporary && tree === leaves(shape.tree)[0] ? { outputKey: 'temp:saved' } : {}),
        ...(shape.persistent && tree === 'a' ? { outputKey: 'saved' } : {}),
      });
    };
    return node(shape.tree);
  };
  const adapter = adapterFactory();
  const measured: typeof adapter = {
    ...adapter,
    async prepare(...args) {
      const prepared = await adapter.prepare(...args);
      return {
        ...prepared,
        async pending(...args: Parameters<NonNullable<typeof prepared.pending>>) {
          const [sessionId, options] = args;
          const original = options?.registerRestoredData;
          return prepared.pending?.(sessionId, {
            ...(original === undefined
              ? {}
              : {
                  registerRestoredData(value: unknown) {
                    registrations.push(value);
                    original(value);
                  },
                }),
          });
        },
        async *run(request) {
          // Observe the actual broker port without replacing its identity or policy.
          const original = request.capabilities.call;
          const call: typeof original = (name, input, options) => {
            capabilities.push(String(Reflect.get(input as object, 'q')));
            if (options?.effectScope !== undefined) scopes.push(options.effectScope);
            return original.call(request.capabilities, name, input, options);
          };
          if (!Reflect.set(request.capabilities, 'call', call))
            throw new Error('Cannot observe effect scopes.');
          try {
            yield* prepared.run(request);
          } finally {
            Reflect.set(request.capabilities, 'call', original);
          }
        },
      };
    },
  };
  const runtime = createRuntime({
    appId: 'last-child-spike',
    executors: [measured as ExecutorAdapter<unknown, unknown>],
    budgets: { steps: 30, toolCalls: 20, tokens: 10000 },
  });
  const model = new FakeChatModel(reply);
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    recovery: store.recovery,
    confirmations: { capabilities: ['docs.save@1'], policyRevision: () => 'workflow-v1' },
    agent: (host: AdkHost) =>
      defineAdkEntry({
        agent: build(host),
        interaction: (calls) => ({
          surfaceId: 'main',
          viewRevision: 'r1',
          component: 'tests.Approval/v1',
          props: { count: calls.length },
        }),
        ...(shape.long ? { resume: () => [{ response: { saved: 'external' } }] } : {}),
      }),
    services: { chatModels: { mock: model }, checkpoints: store.checkpoints },
    bindings: {
      'docs.save@1': {
        kind: 'write',
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 2,
        grantScope: 'instance',
        approval: 'confirm',
        retry: 'none',
        async invoke(input: { q: string }, context: CapabilityContext) {
          expect(approvals.size).toBeGreaterThan(writes.length);
          writes.push(input.q);
          effects.push(context.effectId);
          return { saved: input.q };
        },
      },
    },
    models: routing,
  });
  if (options.duplicatePrepare)
    await expect(instance.prepare()).rejects.toMatchObject({ code: 'unsupported' });
  else await instance.prepare();
  const timer = setInterval(() => {
    for (const pending of instance.getSnapshot().confirmations ?? [])
      if (!approvals.has(pending.id)) {
        approvals.add(pending.id);
        instance.respond(pending.id, 'approve');
      }
  }, 5);
  return {
    runtime,
    instance,
    requests,
    writes,
    effects,
    scopes,
    capabilities,
    registrations,
    approvals,
    cursors,
    shape,
    model,
    store,
    mute() {
      muted = true;
    },
    async close() {
      clearInterval(timer);
      await runtime.dispose();
      store.close();
    },
  };
}
type Life = Awaited<ReturnType<typeof life>>;
async function segment(l: Life): Promise<RunEvent[]> {
  const run = l.instance.getSnapshot().run;
  if (run === undefined) throw new Error('Missing run.');
  const events: RunEvent[] = [];
  const consumed = l.cursors.get(run.runId) ?? -1;
  let sequence = consumed;
  for await (const event of l.instance.events(run.runId)) {
    if (event.sequence <= consumed) continue;
    sequence = event.sequence;
    events.push(event);
    if (
      event.type === 'interaction' &&
      l.instance.getSnapshot().run?.status === 'waiting_input' &&
      event.interaction.interactionId === l.instance.getSnapshot().run?.pending?.interactionId
    )
      break;
  }
  l.cursors.set(run.runId, sequence);
  return events;
}
async function answer(l: Life, action = 'approve'): Promise<RunEvent[]> {
  const run = l.instance.getSnapshot().run;
  if (run?.pending === undefined) throw new Error('Missing pending interaction.');
  const id = run.pending.interactionId;
  expect(
    (
      await l.instance.dispatch({
        instanceId: l.instance.instanceId,
        runId: run.runId,
        ...run.pending,
        action,
        payload: { indexes: l.shape.twoCalls ? [0, 1] : [0] },
      })
    ).status,
  ).toBe('accepted');
  await expect
    .poll(() => {
      const current = l.instance.getSnapshot().run;
      return current?.status === 'waiting_input' && current.pending?.interactionId === id
        ? 'pending'
        : current?.status;
    })
    .not.toBe('pending');
  return segment(l);
}

interface Transcript {
  requests: string[];
  writes: string[];
  scopes: string[];
  interactions: unknown[];
  output: unknown;
}

async function complete(shape: Shape, adapterFactory: AdapterFactory): Promise<Transcript> {
  const shared = await source();
  const l = await life(shape, await shared.open(), adapterFactory);
  try {
    const interactions: unknown[] = [];
    await l.instance.start({ prompt: 'go' });
    let events = await segment(l);
    for (let pauses = 0; l.instance.getSnapshot().run?.pending !== undefined; pauses += 1) {
      expect(pauses).toBeLessThan(3);
      const published = events.filter((event) => event.type === 'interaction');
      expect(published).toHaveLength(1);
      interactions.push(...published.map((event) => event.interaction.props));
      events = await answer(l, shape.deny ? 'deny' : 'approve');
    }
    expect(events.at(-1)?.type).toBe('output');
    const last = events.at(-1);
    return {
      requests: [...l.requests],
      writes: [...l.writes],
      scopes: l.scopes.map((scope) => scope.replace(l.instance.sessionId, '<conversation>')),
      interactions,
      output: last?.type === 'output' ? last.output : undefined,
    };
  } finally {
    await l.close();
    await shared.remove();
  }
}

test.each(controls)(
  'G0 $id preserves the shipped control transcript on the default Runner',
  async (shape) => {
    const baseline = await complete(shape, createAdkAdapter);
    const before = resumed();
    expect(await complete(shape, () => createCandidateAdapter({ shippedPolicy: true }))).toEqual(
      baseline,
    );
    expect(resumed() - before).toBe(0);
    expect(await complete(shape, createCandidateAdapter)).toEqual(baseline);
    expect(resumed() - before).toBe(0);
    expect(baseline.interactions).toEqual([{ count: 1 }]);
    expect(baseline.writes).toEqual(shape.paused);
  },
);

test('G0 the in-place probe resumes only the answered last author', async () => {
  const shared = await source();
  const l = await life(
    { id: 'L1', tree: { seq: ['a', 'b'] }, paused: ['b'] },
    await shared.open(),
    createCandidateAdapter,
  );
  const before = resumed();
  try {
    await l.instance.start({ prompt: 'go' });
    const initial = await segment(l);
    expect(initial.filter((event) => event.type === 'interaction')).toHaveLength(1);
    expect(l.requests).toEqual(['a', 'b']);
    expect(l.writes).toEqual([]);
    expect(resumed() - before).toBe(0);
    const end = await answer(l);
    expect(end.at(-1)).toMatchObject({ type: 'output', output: 'b:done' });
    expect(l.requests).toEqual(['a', 'b', 'b']);
    expect(l.writes).toEqual(['b']);
    expect(resumed() - before).toBe(1);
  } finally {
    await l.close();
    await shared.remove();
  }
});

function normalizedScopes(l: Life): string[] {
  return l.scopes.map((scope) => scope.replace(l.instance.sessionId, '<conversation>'));
}

function row(shape: Shape): NonNullable<(typeof native)[string]> {
  const value = native[shape.id];
  if (value === undefined) throw new Error('Missing measured native transcript.');
  return value;
}

test.each(shapes)(
  'G1 $id candidate live transcript equals the native resumable observation',
  async (shape) => {
    const shared = await source();
    const l = await life(shape, await shared.open(), createCandidateAdapter);
    const before = resumed();
    try {
      await l.instance.start({ prompt: 'go' });
      let events = await segment(l);
      const beforeAnswer = l.writes.filter((tag) => tag !== 'writer');
      // Registered G1 FAIL for L5: a native long-running body starts before
      // the external answer. Pin that observation; host approval remains enforced.
      expect(beforeAnswer).toEqual(shape.id === 'L5' ? ['b'] : []);
      let interactions = 0;
      while (l.instance.getSnapshot().run?.pending !== undefined) {
        expect(interactions).toBeLessThan(3);
        const published = events.filter((event) => event.type === 'interaction');
        expect(published).toHaveLength(1);
        expect(published[0]?.interaction.props).toEqual({ count: shape.twoCalls ? 2 : 1 });
        interactions += 1;
        events = await answer(l, shape.deny ? 'deny' : 'approve');
      }
      expect(events.at(-1)).toMatchObject({ type: 'output', output: row(shape).output });
      expect(l.requests).toEqual(row(shape).requests);
      expect(l.capabilities).toEqual(row(shape).writes);
      expect(l.writes).toEqual(row(shape).writes);
      expect(interactions).toBe(row(shape).pauses);
      expect(resumed() - before).toBe(interactions);
      expect(l.approvals.size).toBe(l.writes.length);
      if (shape.persistent) {
        const instructions = l.model.seen.filter((call) =>
          JSON.stringify(
            call.messages.find((message) => message.type === 'system')?.content,
          ).includes('role=b;'),
        );
        expect(instructions).toHaveLength(2);
        expect(
          instructions.every((call) =>
            JSON.stringify(call.messages).includes('persistent=value-a'),
          ),
        ).toBe(true);
      }
    } finally {
      await l.close();
      await shared.remove();
    }
  },
);

test.each(shapes)('G1 $id shipped adapter keeps its pre-change pause refusal', async (shape) => {
  const shared = await source();
  const l = await life(shape, await shared.open(), createAdkAdapter);
  const before = resumed();
  try {
    await l.instance.start({ prompt: 'go' });
    const first = await segment(l);
    expect(first.at(-1)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
    expect(first.some((event) => event.type === 'interaction')).toBe(false);
    expect(l.requests).toEqual(row(shape).requests.slice(0, -row(shape).pauses));
    expect(l.writes).toEqual(shape.long ? shape.paused : shape.id === 'L8' ? ['writer'] : []);
    expect(
      await l.store.checkpoints.request({
        op: 'get',
        executor: 'adk-js',
        sessionId: l.instance.sessionId,
        namespace: '',
      }),
    ).toBeNull();
    expect(resumed() - before).toBe(0);
  } finally {
    await l.close();
    await shared.remove();
  }
});

test.each(shapes)(
  'G2 $id reopens the same bytes at each pause without requests or writes',
  async (shape) => {
    const baseline = await complete(shape, createCandidateAdapter);
    const shared = await source();
    let l = await life(shape, await shared.open(), createCandidateAdapter);
    const requests: string[] = [];
    const writes: string[] = [];
    const scopes: string[] = [];
    try {
      await l.instance.start({ prompt: 'go' });
      let events = await segment(l);
      let interactions = 0;
      while (l.instance.getSnapshot().run?.pending !== undefined) {
        expect(interactions).toBeLessThan(3);
        const pending = l.instance.getSnapshot().run?.pending?.interactionId;
        const sessionId = l.instance.sessionId;
        requests.push(...l.requests);
        writes.push(...l.writes);
        scopes.push(...normalizedScopes(l));
        await l.close();
        l = await life(shape, await shared.open(), createCandidateAdapter, { sessionId });
        const restoreResumes = resumed();
        await l.instance.restore();
        await waitForRunStatus(l.instance, 'waiting_input');
        const restored = await segment(l);
        expect(restored.filter((event) => event.type === 'interaction')).toHaveLength(1);
        expect(l.instance.getSnapshot().run?.pending?.interactionId).toBe(pending);
        expect(l.requests).toEqual([]);
        expect(l.capabilities).toEqual([]);
        expect(l.writes).toEqual([]);
        expect(resumed()).toBe(restoreResumes);
        events = await answer(l, shape.deny ? 'deny' : 'approve');
        interactions += 1;
      }
      requests.push(...l.requests);
      writes.push(...l.writes);
      scopes.push(...normalizedScopes(l));
      expect(events.at(-1)).toMatchObject({ type: 'output', output: row(shape).output });
      expect(requests).toEqual(baseline.requests);
      expect(writes).toEqual(baseline.writes);
      expect(scopes).toEqual(baseline.scopes);
      expect(interactions).toBe(row(shape).pauses);
    } finally {
      await l.close();
      await shared.remove();
    }
  },
);

function assertScopeGate(shape: Shape, observed: string[], uninterrupted: string[]): void {
  if (shape.id === 'L4') {
    // Registered G3 FAIL, hence REFUSED under ADR-0020's base-shape rule.
    // Keep the complete logical-write arrays and normalize only conversation ID.
    expect(observed).toEqual(['adk/<conversation>/root/0/0', 'adk/<conversation>/root/2/0']);
    expect(uninterrupted).toEqual(['adk/<conversation>/root/0/0', 'adk/<conversation>/root/1/0']);
    expect(observed).not.toEqual(uninterrupted);
  } else expect(observed).toEqual(uninterrupted);
}

test.each(shapes.filter((shape) => !shape.deny))(
  'G3 $id records live versus uninterrupted write scopes',
  async (shape) => {
    const candidate = await complete(shape, createCandidateAdapter);
    const shared = await source();
    const l = await life(shape, await shared.open(), createCandidateAdapter, { ungated: true });
    try {
      await l.instance.start({ prompt: 'go' });
      const events = await segment(l);
      expect(events.at(-1)?.type).toBe('output');
      expect(candidate.writes).toEqual(l.writes);
      assertScopeGate(shape, candidate.scopes, normalizedScopes(l));
    } finally {
      await l.close();
      await shared.remove();
    }
  },
);

test.each(shapes.filter((shape) => ['L1', 'L4', 'L5', 'L8'].includes(shape.id)))(
  'G3 $id writes once across approved-write failure and automatic accepted-inbox replay',
  async (shape) => {
    const referenceSource = await source();
    const reference = await life(shape, await referenceSource.open(), createCandidateAdapter, {
      ungated: true,
    });
    const shared = await source();
    let l = await life(shape, await shared.open(), createCandidateAdapter);
    try {
      await reference.instance.start({ prompt: 'go' });
      expect((await segment(reference)).at(-1)?.type).toBe('output');
      await l.instance.start({ prompt: 'go' });
      await segment(l);
      if (shape.twice) {
        const second = await answer(l);
        expect(second.filter((event) => event.type === 'interaction')).toHaveLength(1);
      }
      const initialWrites = [...l.writes];
      const initialEffects = [...l.effects];
      const initialScopes = normalizedScopes(l);
      const sessionId = l.instance.sessionId;
      const pending = l.instance.getSnapshot().run?.pending?.interactionId;
      await l.close();
      l = await life(shape, await shared.open(), createCandidateAdapter, {
        sessionId,
        crash: true,
        crashAfter: shape.twice ? 2 : 1,
      });
      await l.instance.restore();
      await waitForRunStatus(l.instance, 'waiting_input');
      expect(l.instance.getSnapshot().run?.pending?.interactionId).toBe(pending);
      expect(l.requests).toEqual([]);
      expect(l.capabilities).toEqual([]);
      expect(l.writes).toEqual([]);
      const failed = await answer(l);
      expect(failed.at(-1)).toMatchObject({ type: 'error', error: { code: 'unavailable' } });
      const failedScopes = [...l.scopes];
      const combinedScopes = [...initialScopes, ...normalizedScopes(l)];
      const combinedWrites = [...initialWrites, ...l.writes];
      const combinedEffects = [...initialEffects, ...l.effects];
      expect(combinedWrites).toEqual(row(shape).writes);
      expect(new Set(combinedEffects).size).toBe(combinedWrites.length);
      await l.close();
      l = await life(shape, await shared.open(), createCandidateAdapter, { sessionId });
      await l.instance.restore();
      await waitForRunStatus(l.instance, 'succeeded');
      expect((await segment(l)).at(-1)).toMatchObject({
        type: 'output',
        output: row(shape).output,
      });
      expect(l.writes).toEqual([]);
      expect(l.effects).toEqual([]);
      expect(l.scopes).toEqual(failedScopes);
      assertScopeGate(shape, combinedScopes, normalizedScopes(reference));
    } finally {
      await l.close();
      await shared.remove();
      await reference.close();
      await referenceSource.remove();
    }
  },
);

type RestoreChange =
  | 'middle'
  | 'loop'
  | 'parallel'
  | 'unknown'
  | 'nonleaf'
  | 'temp-key'
  | 'missing-history'
  | 'agentState'
  | 'endOfAgent'
  | 'older-executor';
const restoreChanges: RestoreChange[] = [
  'middle',
  'loop',
  'parallel',
  'unknown',
  'nonleaf',
  'temp-key',
  'missing-history',
  'agentState',
  'endOfAgent',
  'older-executor',
];

async function storedCandidate(shape: Shape) {
  const bytes = new MemoryByteCheckpoints();
  const recovery = new MemoryRecoveryStore();
  const store = { checkpoints: bytes, recovery, close() {} };
  const l = await life(shape, store, createCandidateAdapter);
  const sessionId = l.instance.sessionId;
  try {
    await l.instance.start({ prompt: 'go' });
    expect((await segment(l)).at(-1)?.type).toBe('interaction');
    // Also retain the second in-place pause for the repeated-confirmation shape.
    if (shape.twice) expect((await answer(l)).at(-1)?.type).toBe('interaction');
  } finally {
    await l.close();
  }
  return { bytes, recovery, store, sessionId };
}

test.each(shapes.flatMap((shape) => restoreChanges.map((change) => ({ shape, change }))))(
  'G4 $shape.id $change rejects before registration and leaves rows unchanged on repeated restore',
  async ({ shape, change }) => {
    const { bytes, store, sessionId } = await storedCandidate(shape);
    const author = shape.paused[0];
    if (author === undefined) throw new Error('Missing stored pause author.');
    let tree: Tree = shape.tree;
    if (change === 'middle') tree = { seq: [...leaves(shape.tree), 'after'] };
    if (change === 'loop') tree = { loop: [author] };
    if (change === 'parallel') tree = { par: leaves(shape.tree) };
    if (change === 'unknown') tree = 'replacement';
    if (change === 'nonleaf')
      tree = { seq: [leaves(shape.tree)[0] ?? 'before', { transfer: 'nested', name: author }] };
    if (['missing-history', 'agentState', 'endOfAgent'].includes(change)) {
      const latest = [...bytes.rows].sort((a, b) => b[1].id.localeCompare(a[1].id))[0];
      if (latest === undefined) throw new Error('Missing stored candidate row.');
      const [key, row] = latest;
      const body = JSON.parse(new TextDecoder().decode(row.checkpoint.bytes));
      if (change === 'missing-history')
        body.events = body.events.filter(
          (event: { author?: string }) => event.author !== leaves(shape.tree)[0],
        );
      else {
        body.events[0].actions ??= {};
        body.events[0].actions[change] =
          change === 'agentState' ? { [author]: { progress: 1 } } : true;
      }
      bytes.rows.set(key, {
        ...row,
        checkpoint: { ...row.checkpoint, bytes: new TextEncoder().encode(JSON.stringify(body)) },
      });
    }
    const before = structuredClone({ rows: [...bytes.rows], writes: [...bytes.writes] });
    const changed: Shape = {
      ...shape,
      tree,
      ...(change === 'temp-key' ? { temporary: true, persistent: false } : {}),
    };
    const l = await life(
      changed,
      store,
      change === 'older-executor' ? createAdkAdapter : createCandidateAdapter,
      { sessionId },
    );
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(l.instance.restore()).rejects.toMatchObject({ code: 'unrecoverable' });
        expect(l.requests).toEqual([]);
        expect(l.capabilities).toEqual([]);
        expect(l.writes).toEqual([]);
        expect(l.registrations).toEqual([]);
        expect(l.instance.getSnapshot().run?.pending).toBeUndefined();
        expect({ rows: [...bytes.rows], writes: [...bytes.writes] }).toEqual(before);
      }
    } finally {
      await l.close();
    }
  },
);

const refusals: Shape[] = [
  { id: 'R1', tree: { seq: ['a', 'b', 'c'] }, paused: ['b'] },
  { id: 'R2', tree: { seq: ['a', { seq: ['b', 'c'] }] }, paused: ['b'] },
  { id: 'R3', tree: { seq: ['a', 'b'] }, paused: ['b'], temporary: true },
  { id: 'R4', tree: { loop: ['worker'] }, paused: ['worker'] },
  { id: 'R5', tree: { loop: ['writer', 'checker'] }, paused: ['checker'] },
  { id: 'R6-left', tree: { seq: [{ par: ['left', 'right'] }, 'merger'] }, paused: ['left'] },
  {
    id: 'R6-right',
    tree: { seq: [{ par: ['left', 'right'] }, 'merger'] },
    paused: ['left'],
    rightFirst: true,
  },
  { id: 'R6-last', tree: { seq: ['a', { par: ['left', 'right'] }] }, paused: ['left'] },
  { id: 'R6-both', tree: { par: ['left', 'right'] }, paused: ['left', 'right'] },
  { id: 'R7', tree: { seq: ['a', 'b', 'c'] }, paused: ['b'], long: true },
  { id: 'R8', tree: { seq: ['a', { transfer: 'child' }, 'c'] }, paused: ['child'] },
  { id: 'R9', tree: { seq: ['a', { transfer: 'child' }] }, paused: ['child'] },
  { id: 'R10', tree: { seq: [{ loop: ['w'] }, 'b'] }, paused: ['b'] },
];
const lanes: { lane: string; factory: AdapterFactory }[] = [
  { lane: 'candidate', factory: createCandidateAdapter },
  { lane: 'shipped', factory: createAdkAdapter },
];

test.each(refusals.flatMap((shape) => lanes.map((lane) => ({ shape, ...lane }))))(
  'G5 $shape.id $lane refuses without a stored pause or late capability, then starts cleanly',
  async ({ shape, factory }) => {
    const shared = await source();
    const l = await life(shape, await shared.open(), factory);
    const before = resumed();
    try {
      await l.instance.start({ prompt: 'go' });
      const first = await segment(l);
      expect(first.at(-1)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
      expect(first.some((event) => event.type === 'interaction')).toBe(false);
      expect(l.instance.getSnapshot().run?.pending).toBeUndefined();
      const writes = [...l.writes];
      const capabilities = [...l.capabilities];
      await sleep(45);
      expect(l.writes).toEqual(writes);
      expect(l.capabilities).toEqual(capabilities);
      expect(l.writes.filter((tag) => shape.paused.includes(tag))).toEqual(
        shape.long ? shape.paused : [],
      );
      expect(
        await l.store.checkpoints.request({
          op: 'get',
          executor: 'adk-js',
          sessionId: l.instance.sessionId,
          namespace: '',
        }),
      ).toBeNull();
      expect(resumed() - before).toBe(0);
      const prior = l.model.seen.length;
      l.mute();
      await l.instance.start({ prompt: 'retry-after-refusal' });
      expect((await segment(l)).at(-1)?.type).toBe('output');
      const humans = l.model.seen
        .slice(prior)
        .flatMap((call) =>
          call.messages
            .filter((message) => message.type === 'human')
            .map((message) => message.content),
        );
      expect(humans).not.toContain('go');
      expect(humans).toContain('retry-after-refusal');
      expect(l.writes).toEqual(writes);
    } finally {
      await l.close();
      await shared.remove();
    }
  },
);

// Preserve the registered missing-earlier-history G4 control through the real
// candidate route as well as the byte-identical existing shipped test.
test('G4 last keeps rejecting a solo-agent pause restored into a later leaf', async () => {
  const { bytes, store, sessionId } = await storedCandidate({
    id: 'solo',
    tree: 'b',
    paused: ['b'],
  });
  const before = structuredClone({ rows: [...bytes.rows], writes: [...bytes.writes] });
  const l = await life(
    { id: 'last', tree: { seq: ['a', 'b'] }, paused: ['b'] },
    store,
    createCandidateAdapter,
    { sessionId },
  );
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(l.instance.restore()).rejects.toMatchObject({ code: 'unrecoverable' });
      expect(l.requests).toEqual([]);
      expect(l.capabilities).toEqual([]);
      expect(l.writes).toEqual([]);
      expect(l.registrations).toEqual([]);
      expect({ rows: [...bytes.rows], writes: [...bytes.writes] }).toEqual(before);
    }
  } finally {
    await l.close();
  }
});
