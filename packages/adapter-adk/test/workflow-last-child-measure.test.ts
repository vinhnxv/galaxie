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
import { MemoryRecoveryStore } from '../../core/test/support/memory-recovery-store.js';
import { IndexedDBSaver } from '../../storage-indexeddb/src/index.js';
import { createAdkAdapter } from '../src/adapter.js';
import type { AdkHost } from '../src/host.js';
import { defineAdkEntry } from '../src/interaction.js';
import { createCandidateAdapter, resumed } from './support/candidate-adapter.js';
import { FakeChatModel, type Reply } from './support/fixtures.js';

/* G0 checkpoint: candidate drift and C1-C4 control faithfulness, plus one
 * in-place L1 probe. Other registered gates remain UNMEASURED at this checkpoint.
 * Scripted models only; Node and Chromium are measured separately.
 * Registered gates and fixed predictions: ADR-0020, "Last-child rerun".
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
type AdapterFactory = () => ReturnType<typeof createAdkAdapter>;
const controls: Shape[] = [
  { id: 'C1', tree: { seq: ['first', 'second'] }, paused: ['first'] },
  { id: 'C2', tree: { seq: [{ seq: ['inner', 'b'] }, 'c'] }, paused: ['inner'] },
  { id: 'C3', tree: { transfer: 'child' }, paused: ['child'] },
  { id: 'C4', tree: 'solo', paused: ['solo'] },
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
    ungated?: boolean;
    duplicatePrepare?: boolean;
  } = {},
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
  const adapter = adapterFactory();
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
