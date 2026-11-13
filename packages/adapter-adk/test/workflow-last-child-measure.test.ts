// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  type ModelRouting,
  type RunEvent,
} from '@galaxie-ai/core';
import { type BaseAgent, LlmAgent, LoopAgent, ParallelAgent, SequentialAgent } from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { MemoryByteCheckpoints } from '../../../tests/conformance/support/memory-byte-checkpoints.js';
import { MemoryRecoveryStore } from '../../core/test/support/memory-recovery-store.js';
import { IndexedDBSaver } from '../../storage-indexeddb/src/index.js';
import { createAdkAdapter } from '../src/adapter.js';
import type { AdkHost } from '../src/host.js';
import { defineAdkEntry } from '../src/interaction.js';
import { FakeChatModel, type Reply } from './support/fixtures.js';

/* Standing shipped-adapter refusals for the last-child and excluded workflow shapes.
 * The admission-capable experiment was REFUSED; ADR-0020 records its gate table,
 * literal failures and per-engine evidence. Models here are scripted, with memory
 * storage on Node and real IndexedDB in browsers; no real provider is measured.
 */

type Tree = string | { seq: Tree[] } | { loop: Tree[] } | { par: Tree[] } | { transfer: Tree };
interface Shape {
  id: string;
  tree: Tree;
  paused: string[];
  twice?: boolean;
  long?: boolean;
  rightFirst?: boolean;
  temporary?: boolean;
  twoCalls?: boolean;
  persistent?: boolean;
}
const shapes: Shape[] = [
  { id: 'L1', tree: { seq: ['a', 'b'] }, paused: ['b'] },
  { id: 'L2', tree: { seq: ['a', 'b'] }, paused: ['b'] },
  { id: 'L3', tree: { seq: ['a', { seq: ['b', 'c'] }] }, paused: ['c'] },
  { id: 'L4', tree: { seq: ['a', 'b'] }, paused: ['b'], twice: true },
  { id: 'L5', tree: { seq: ['a', 'b'] }, paused: ['b'], long: true },
  { id: 'L6', tree: { seq: ['a', { seq: ['b', { seq: ['c', 'd'] }] }] }, paused: ['d'] },
  { id: 'L7', tree: { seq: ['a', 'b'] }, paused: ['b'], twoCalls: true },
  { id: 'L8', tree: { seq: ['writer', 'b'] }, paused: ['b'] },
  { id: 'L9', tree: { seq: ['a', 'b'] }, paused: ['b'], persistent: true },
];

// Native request orders and pause counts pin each shipped pre-refusal prefix.
const native: Record<string, { requests: string[]; pauses: number }> = {
  L1: { requests: ['a', 'b', 'b'], pauses: 1 },
  L2: { requests: ['a', 'b', 'b'], pauses: 1 },
  L3: { requests: ['a', 'b', 'c', 'c'], pauses: 1 },
  L4: { requests: ['a', 'b', 'b', 'b'], pauses: 2 },
  L5: { requests: ['a', 'b', 'b'], pauses: 1 },
  L6: { requests: ['a', 'b', 'c', 'd', 'd'], pauses: 1 },
  L7: { requests: ['a', 'b', 'b'], pauses: 1 },
  L8: { requests: ['writer', 'writer', 'b', 'b'], pauses: 1 },
  L9: { requests: ['a', 'b', 'b'], pauses: 1 },
};
function row(shape: Shape): NonNullable<(typeof native)[string]> {
  const value = native[shape.id];
  if (value === undefined) throw new Error('Missing measured native transcript.');
  return value;
}
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

async function life(shape: Shape, store: Store) {
  const requests: string[] = [];
  const writes: string[] = [];
  const capabilities: string[] = [];
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
          name: 'parent',
          instruction: 'role=parent;',
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
            ...(shape.paused.includes(tree)
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
            capabilities.push(String(Reflect.get(input as object, 'q')));
            return original.call(request.capabilities, name, input, options);
          };
          if (!Reflect.set(request.capabilities, 'call', call))
            throw new Error('Cannot observe capability calls.');
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
        async invoke(input: { q: string }) {
          expect(approvals.size).toBeGreaterThan(writes.length);
          writes.push(input.q);
          return { saved: input.q };
        },
      },
    },
    models: routing,
  });
  await instance.prepare();
  const timer = setInterval(() => {
    for (const pending of instance.getSnapshot().confirmations ?? [])
      if (!approvals.has(pending.id)) {
        approvals.add(pending.id);
        instance.respond(pending.id, 'approve');
      }
  }, 5);
  return {
    instance,
    requests,
    writes,
    capabilities,
    cursors,
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
test.each(shapes)('G1 $id shipped adapter keeps its pre-change pause refusal', async (shape) => {
  const shared = await source();
  const l = await life(shape, await shared.open());
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
  } finally {
    await l.close();
    await shared.remove();
  }
});

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
test.each(refusals)(
  'G5 $id shipped refuses without a stored pause or late capability, then starts cleanly',
  async (shape) => {
    const shared = await source();
    const l = await life(shape, await shared.open());
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
