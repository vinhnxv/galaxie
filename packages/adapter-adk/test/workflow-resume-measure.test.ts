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
import { FakeChatModel, type Reply } from './support/fixtures.js';
import { withResumableRunner } from './support/resumable-seam.js';

/* All gates, all shapes (Node/Chromium; see native file for individual N gates):
 * Shape       N1    N2   N3   G1          G2         G3           G4       G5
 * W1          FAIL  PASS NA   PASS(native) PASS       PASS         FAIL     PASS
 * W2          FAIL  PASS PASS FAIL(refused) NA        NA           FAIL     PASS
 * W3-first    FAIL  PASS NA   PASS(native) PASS       PASS         FAIL     PASS
 * W3-later    FAIL  PASS PASS FAIL(refused) NA        NA           FAIL     PASS
 * W4 variants PASS  PASS PASS FAIL(refused) NA        NA           FAIL     PASS
 * W5 variants FAIL  PASS NA   FAIL(refused) NA        NA           FAIL     PASS
 * W6 variants FAIL  mixed *   FAIL(refused) NA        NA           FAIL     PASS
 * W7-last     PASS  PASS PASS FAIL(refused) NA        NA           FAIL     PASS
 * W7-middle   FAIL  PASS PASS FAIL(refused) NA        NA           FAIL     PASS
 * W8          PASS  PASS NA   PASS(native) PASS       PASS         FAIL     PASS
 * W8-workflow FAIL  PASS PASS FAIL(refused) NA        NA           FAIL     PASS
 * * W6-last preserves state, other W6 variants have no prior state. W6-both
 * loses one body; other W6 variants execute the answered tool once natively.
 * W4-temp loses temp output (N3 informational); deny executes zero bodies.
 * NA G2/G3: the real pause rule publishes no interaction or stored pause for
 * that shape, so reload/approve/retry cannot be driven. No admission bypass
 * was added. G4 is a shared changed-tree/forged-record gate measured below.
 * Its FAIL values record unchanged code; shipped code now rejects all eight
 * cases (ADR-0020, Restore admission and workflow-state rejection).
 * Decision after all measurements: REFUSED. W4 fails G1; no new shape passes
 * all gates. The routing-only seam cannot admit a later pause. W6 scope loss
 * cannot be reached through this seam and is unmeasured here (not a pass).
 * The predicted overall acceptance and W4/W7-last G1-G3 success were not
 * established. Native continuity predictions and unchanged-code G4 failure
 * held. Conditional shipped-code G4 was not run on this refusal branch.
 */

type Tree = string | { seq: Tree[] } | { loop: Tree[] } | { par: Tree[] } | { transfer: Tree };
interface Shape {
  id: string;
  tree: Tree;
  paused: string[];
  deny?: boolean;
  twice?: boolean;
  long?: boolean;
  rightFirst?: boolean;
  temporary?: boolean;
}
const shapes: Shape[] = [
  { id: 'W1', tree: { seq: ['first', 'second'] }, paused: ['first'] },
  { id: 'W2', tree: { seq: ['a', 'b', 'c'] }, paused: ['b'] },
  { id: 'W3-first', tree: { seq: [{ seq: ['inner', 'b'] }, 'c'] }, paused: ['inner'] },
  { id: 'W3-later', tree: { seq: ['a', { seq: ['b', 'c'] }] }, paused: ['b'] },
  { id: 'W4', tree: { seq: ['a', 'b'] }, paused: ['b'] },
  { id: 'W4-deny', tree: { seq: ['a', 'b'] }, paused: ['b'], deny: true },
  { id: 'W4-nested', tree: { seq: ['a', { seq: ['b', 'c'] }] }, paused: ['c'] },
  { id: 'W4-twice', tree: { seq: ['a', 'b'] }, paused: ['b'], twice: true },
  { id: 'W4-temp', tree: { seq: ['a', 'b'] }, paused: ['b'], temporary: true },
  { id: 'W5-worker', tree: { loop: ['worker'] }, paused: ['worker'] },
  { id: 'W5-writer', tree: { loop: ['writer', 'checker'] }, paused: ['checker'] },
  { id: 'W6-left', tree: { seq: [{ par: ['left', 'right'] }, 'merger'] }, paused: ['left'] },
  {
    id: 'W6-right',
    tree: { seq: [{ par: ['left', 'right'] }, 'merger'] },
    paused: ['left'],
    rightFirst: true,
  },
  { id: 'W6-last', tree: { seq: ['a', { par: ['left', 'right'] }] }, paused: ['left'] },
  { id: 'W6-both', tree: { par: ['left', 'right'] }, paused: ['left', 'right'] },
  { id: 'W7-last', tree: { seq: ['a', 'b'] }, paused: ['b'], long: true },
  { id: 'W7-middle', tree: { seq: ['a', 'b', 'c'] }, paused: ['b'], long: true },
  { id: 'W8', tree: { transfer: 'child' }, paused: ['child'] },
  { id: 'W8-workflow', tree: { seq: ['a', { transfer: 'child' }, 'c'] }, paused: ['child'] },
];

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
  id: 'tests/adk-workflow-resume',
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
const control = (shape: Shape): boolean => ['W1', 'W3-first', 'W8', 'solo'].includes(shape.id);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function source() {
  const bytes = new MemoryByteCheckpoints();
  const journal = new MemoryRecoveryStore();
  const name = `adk-workflow-${crypto.randomUUID()}`;
  return {
    bytes,
    journal,
    async open() {
      if (typeof indexedDB === 'undefined')
        return { checkpoints: bytes, recovery: journal, close() {} };
      const saver = await IndexedDBSaver.open({
        databaseName: name,
        appId: 'workflow-spike',
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
  options: { sessionId?: SessionId; crash?: boolean; ungated?: boolean } = {},
) {
  const requests: string[] = [];
  const writes: string[] = [];
  const effects: string[] = [];
  const scopes: string[] = [];
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
      (message) => message.type === 'tool' && message.name === `save_${tag}`,
    ).length;
    if (options.crash && answered > 0) throw new Error('Scripted failure after approved write.');
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
      ? new AIMessage({ content: `${tag}:done` })
      : new AIMessage({ content: '', tool_calls: [{ id: 'call_0', ...call }] });
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
          name: 'parent',
          instruction: 'role=parent;',
          model: host.adk.llm('agent'),
          subAgents: [node(tree.transfer)],
        });
      }
      return new LlmAgent({
        name: tree,
        instruction: `role=${tree};`,
        model: host.adk.llm('agent'),
        tools: [
          host.adk.capabilityTool('docs.save@1', {
            toolName: `save_${tree}`,
            description: 'Save one scripted note.',
            parameters: z.object({ q: z.string() }),
            ...(shape.paused.includes(tree) && !options.ungated
              ? shape.long
                ? { longRunning: true }
                : { requireConfirmation: true }
              : {}),
          }),
        ],
        ...(shape.temporary && tree === 'a' ? { outputKey: 'temp:saved' } : {}),
      });
    };
    return node(shape.tree);
  };
  const adapter = createAdkAdapter();
  const measured: typeof adapter = {
    ...adapter,
    async prepare(...args) {
      const prepared = await adapter.prepare(...args);
      return {
        ...prepared,
        async *run(request) {
          // Observe the actual broker port without replacing its identity or policy.
          const original = request.capabilities.call;
          const call: typeof original = (name, input, options) => {
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
    appId: 'workflow-spike',
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
          writes.push(input.q);
          effects.push(context.effectId);
          return { saved: input.q };
        },
      },
    },
    models: routing,
  });
  await instance.prepare();
  const timer = setInterval(() => {
    for (const pending of instance.getSnapshot().confirmations ?? [])
      instance.respond(pending.id, 'approve');
  }, 5);
  return {
    runtime,
    instance,
    requests,
    writes,
    effects,
    scopes,
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
  for await (const event of l.instance.events(run.runId)) {
    events.push(event);
    if (
      event.type === 'interaction' &&
      l.instance.getSnapshot().run?.status === 'waiting_input' &&
      event.interaction.interactionId === l.instance.getSnapshot().run?.pending?.interactionId
    )
      break;
  }
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
        payload: { indexes: [0] },
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

// Every shape is driven through both the unchanged and routing-seam adapters.
test.each([...shapes, { id: 'solo', tree: 'solo', paused: ['solo'] } as Shape])(
  '$id measures live parity and refusal/control preservation',
  async (shape) => {
    const run = async (
      seam: boolean,
    ): Promise<{ requests: string[]; terminal: string | undefined }> => {
      const shared = await source();
      const l = await life(shape, await shared.open());
      try {
        await l.instance.start({ prompt: 'go' });
        const first = await segment(l);
        if (!control(shape)) {
          const last = first.at(-1);
          expect(last?.type === 'error' ? last.error.code : undefined).toBe('unsupported');
          expect(first.some((event) => event.type === 'interaction')).toBe(false);
          if (shape.rightFirst) {
            expect(l.writes).toEqual(['right']);
            expect(l.requests).toEqual(['left', 'right', 'right']);
          }
          const before = [...l.writes];
          await sleep(45);
          expect(l.writes).toEqual(before);
          // Long-running bodies start before their pending result is observed.
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
          return { requests: l.requests, terminal: 'unsupported' };
        }
        expect(first.at(-1)?.type).toBe('interaction');
        expect(l.writes).toEqual([]);
        const end = await answer(l);
        expect(end.at(-1)?.type).toBe('output');
        expect(l.writes).toEqual(shape.paused);
        if (shape.id === 'W1')
          expect(l.requests).toEqual(seam ? ['first', 'first'] : ['first', 'first', 'second']);
        if (shape.id === 'W3-first')
          expect(l.requests).toEqual(seam ? ['inner', 'inner'] : ['inner', 'inner', 'b', 'c']);
        if (shape.id === 'W8') expect(l.requests).toEqual(['parent', 'child', 'child']);
        return { requests: l.requests, terminal: 'output' };
      } finally {
        await l.close();
        await shared.remove();
      }
    };
    await run(false);
    await withResumableRunner(async () => {
      await run(true);
    });
  },
);

// G2/G3 exist for the admitted controls; every refused shape has NA with the
// concrete reason above, rather than a fabricated passing continuation.
test.each(shapes.filter(control))(
  '$id reload matches its native resumable transcript',
  async (shape) => {
    await withResumableRunner(async (routed) => {
      const shared = await source();
      let l = await life(shape, await shared.open());
      try {
        await l.instance.start({ prompt: 'go' });
        expect((await segment(l)).filter((event) => event.type === 'interaction')).toHaveLength(1);
        const before = [...l.requests];
        const pending = l.instance.getSnapshot().run?.pending?.interactionId;
        const sessionId = l.instance.sessionId;
        await l.close();
        l = await life(shape, await shared.open(), { sessionId });
        await l.instance.restore();
        await waitForRunStatus(l.instance, 'waiting_input');
        expect(l.instance.getSnapshot().run?.pending?.interactionId).toBe(pending);
        expect(l.requests).toEqual([]);
        expect(l.writes).toEqual([]);
        const end = await answer(l);
        const tag = shape.paused[0];
        expect(end.at(-1)).toMatchObject({ type: 'output', output: `${tag}:done` });
        expect([...before, ...l.requests]).toEqual(
          shape.id === 'W8' ? ['parent', 'child', 'child'] : [tag, tag],
        );
        expect(l.writes).toEqual(shape.paused);
        expect(routed()).toBeGreaterThan(0);
      } finally {
        await l.close();
        await shared.remove();
      }
    });
  },
);

test.each(shapes.filter(control))(
  '$id measures reload identity and approved-write failure/retry',
  async (shape) => {
    await withResumableRunner(async (routed) => {
      const shared = await source();
      let l = await life(shape, await shared.open());
      try {
        await l.instance.start({ prompt: 'go' });
        await segment(l);
        const id = l.instance.getSnapshot().run?.pending?.interactionId;
        const sessionId = l.instance.sessionId;
        await l.close();
        l = await life(shape, await shared.open(), { sessionId, crash: true });
        await l.instance.restore();
        await waitForRunStatus(l.instance, 'waiting_input');
        expect(l.requests).toEqual([]);
        expect(l.instance.getSnapshot().run?.pending?.interactionId).toBe(id);
        const failed = await answer(l);
        expect(failed.at(-1)?.type === 'error' ? failed.at(-1) : undefined).toMatchObject({
          error: { code: 'unavailable' },
        });
        expect(l.writes).toEqual(shape.paused);
        const scopes = [...l.scopes];
        await l.close();
        l = await life(shape, await shared.open(), { sessionId });
        await l.instance.restore();
        // The durable accepted inbox automatically replays the failed answer.
        await waitForRunStatus(l.instance, 'succeeded');
        const end = await segment(l);
        expect(end.at(-1)?.type).toBe('output');
        expect(l.writes).toEqual([]);
        expect(l.scopes).toEqual(scopes);
        // Compare receipt identity to an uninterrupted run with the identical
        // conversation and tree. No effect-scope format or broker is patched.
        const reference = await source();
        const full = await life(shape, await reference.open(), { ungated: true });
        try {
          await full.instance.start({ prompt: 'go' });
          expect((await segment(full)).at(-1)?.type).toBe('output');
          expect(
            full.scopes.map((scope) => scope.replace(full.instance.sessionId, '<conversation>')),
          ).toEqual(scopes.map((scope) => scope.replace(sessionId, '<conversation>')));
        } finally {
          await full.close();
          await reference.remove();
        }
        expect(routed()).toBeGreaterThan(0);
      } finally {
        await l.close();
        await shared.remove();
      }
    });
  },
);

// G4 starts from a real default-runner pause. Moving its same-named author
// models changed author code without forging the integrity stamps.
test.each([
  { id: 'last', tree: { seq: ['a', 'b'] } },
  { id: 'middle', tree: { seq: ['a', 'b', 'c'] } },
  { id: 'loop', tree: { loop: ['b'] } },
  { id: 'parallel', tree: { par: ['b', 'right'] } },
  { id: 'duplicate', tree: { seq: ['b', { seq: ['b'] }] } },
  { id: 'unknown', tree: 'other' },
  { id: 'agentState', tree: 'b' },
  { id: 'endOfAgent', tree: 'b' },
  { id: 'first', tree: { seq: ['b', 'c'] } },
] as { id: string; tree: Tree }[])(
  'restore admission: $id is rejected before publication unless admitted',
  async ({ id, tree }) => {
    // Mutable memory bytes are intentional here, on both projects, to measure
    // forged actions. Reload above separately uses real IndexedDB in Chromium.
    const bytes = new MemoryByteCheckpoints();
    const recovery = new MemoryRecoveryStore();
    const store = { checkpoints: bytes, recovery, close() {} };
    let l = await life({ id: 'solo', tree: 'b', paused: ['b'] }, store);
    try {
      await l.instance.start({ prompt: 'go' });
      await segment(l);
      const sessionId = l.instance.sessionId;
      const pending = l.instance.getSnapshot().run?.pending?.interactionId;
      await l.close();
      if (['agentState', 'endOfAgent'].includes(id)) {
        const row = [...bytes.rows.values()][0];
        if (row === undefined) throw new Error('Missing stored pause.');
        const body = JSON.parse(new TextDecoder().decode(row.checkpoint.bytes));
        body.events[0].actions[id] = id === 'agentState' ? { b: { progress: 1 } } : true;
        bytes.rows.set(JSON.stringify([sessionId, '', row.id]), {
          ...row,
          checkpoint: { ...row.checkpoint, bytes: new TextEncoder().encode(JSON.stringify(body)) },
        });
      }
      const before = structuredClone([...bytes.rows]);
      l = await life({ id, tree, paused: ['b'] }, store, { sessionId });
      if (id !== 'first') {
        await expect(l.instance.restore()).rejects.toMatchObject({ code: 'unrecoverable' });
        expect(l.requests).toEqual([]);
        expect(l.writes).toEqual([]);
        expect(l.instance.getSnapshot().run?.pending).toBeUndefined();
        expect([...bytes.rows]).toEqual(before);
        return;
      }
      await l.instance.restore();
      await waitForRunStatus(l.instance, 'waiting_input');
      expect(l.requests).toEqual([]);
      expect(l.writes).toEqual([]);
      expect(l.instance.getSnapshot().run?.pending?.interactionId).toBe(pending);
      expect([...bytes.rows]).toEqual(before);
      const end = await answer(l);
      expect(l.requests).toEqual(['b', 'c']);
      expect(l.writes).toEqual(['b']);
      expect(end.at(-1)?.type).toBe('output');
    } finally {
      await l.close();
    }
  },
);
