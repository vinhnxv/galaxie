// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter, requestInteraction } from '@galaxie/adapter-langgraph';
import {
  type AgentInstance,
  type CapabilityBinding,
  type CapabilityContext,
  createRuntime,
  type DiagnosticEvent,
  type RecoveryStore,
  type SessionId,
  type UserInteractionEvent,
} from '@galaxie/core';
import { IndexedDBSaver } from '@galaxie/storage-indexeddb';
import {
  Annotation,
  type BaseCheckpointSaver,
  END,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph/web';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { assistantRoles, assistantRouting } from './support/routing.js';
import { ScriptedChatModel } from './support/scripted-chat-model.js';
import type { ConformanceGraph } from './support/transcript.js';

const modes = ['async', 'sync', 'exit'] as const;
type Durability = (typeof modes)[number];
const answer = { action: 'submit', payload: { answer: 'once' } } as const;
const runtimes: Array<{ dispose(): Promise<void> }> = [];
const savers: IndexedDBSaver[] = [];
const databases: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const saver of savers.splice(0)) saver.close();
  for (const name of databases.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Recovery database cleanup was blocked.'));
    });
  }
});

function gate() {
  return Promise.withResolvers<void>();
}

interface GraphOptions {
  readonly invoke?: (input: string, context: CapabilityContext) => Promise<{ saved: string }>;
  readonly retry?: CapabilityBinding['retry'];
  readonly inputs?: readonly string[];
  readonly read?: boolean;
  readonly afterWrite?: (signal: AbortSignal) => Promise<void>;
}

async function fixture(
  durability: Durability,
  saver: BaseCheckpointSaver,
  recovery: RecoveryStore,
  options: GraphOptions = {},
  sessionId?: SessionId,
) {
  const diagnostics: DiagnosticEvent[] = [];
  const writes: CapabilityContext[] = [];
  const reads: CapabilityContext[] = [];
  const runtime = createRuntime({
    appId: 'recovery-conformance',
    executors: [createLangGraphAdapter()],
    diagnostics: (event) => diagnostics.push(event),
  });
  runtimes.push(runtime);
  let graph: ConformanceGraph | undefined;
  const policy = {
    destination: 'in-browser',
    timeoutMs: 10000,
    concurrency: 1,
    grantScope: 'instance',
    approval: 'none',
    retry: options.retry ?? 'none',
  } as const;
  const request = { input: z.string(), output: z.object({ saved: z.string() }) };
  const instance = await runtime.create(
    {
      id: 'conformance/recovery',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({}),
      models: assistantRoles,
      capabilities: {
        required: {
          'save@1': { ...request, kind: 'write' },
          'read@1': { ...request, kind: 'read' },
        },
      },
    },
    {
      principalScope: 'conformance',
      recovery,
      ...(sessionId === undefined ? {} : { sessionId }),
      models: assistantRouting(),
      services: { checkpointer: saver, chatModels: { assistant: new ScriptedChatModel({}) } },
      bindings: {
        'save@1': {
          ...policy,
          kind: 'write',
          invoke: async (input, context) => {
            writes.push(context);
            return options.invoke === undefined ? { saved: input } : options.invoke(input, context);
          },
        },
        'read@1': {
          ...policy,
          kind: 'read',
          invoke: async (input, context) => {
            reads.push(context);
            return { saved: input };
          },
        },
      },
      agent: (host) => {
        const state = Annotation.Root({
          answer: Annotation<unknown>,
          applications: Annotation<number>({
            reducer: (left, right) => left + right,
            default: () => 0,
          }),
          receipts: Annotation<unknown[]>,
        });
        graph = new StateGraph(state)
          .addNode('ask', async (_state, config) => {
            const submitted = requestInteraction(
              {
                surfaceId: 'main',
                viewRevision: 'r1',
                component: 'conformance.Question/v1',
                props: { question: 'Continue?' },
              },
              config,
            );
            const receipts: unknown[] = [];
            if (options.read) await host.capabilities.call('read@1', 'read', config);
            for (const input of options.inputs ?? ['first'])
              receipts.push(await host.capabilities.call('save@1', input, config));
            if (options.afterWrite !== undefined) {
              if (config.signal === undefined) throw new Error('The graph signal is missing.');
              await options.afterWrite(config.signal);
            }
            return { answer: submitted.payload, applications: 1, receipts };
          })
          .addEdge(START, 'ask')
          .addEdge('ask', END)
          .compile({ checkpointer: host.langchain.checkpointer() })
          .withConfig({ durability });
        return graph;
      },
    },
  );
  await instance.prepare();
  if (graph === undefined) throw new Error('The recovery graph was not prepared.');
  return { runtime, instance, graph, writes, reads, diagnostics };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function event(instance: AgentInstance<unknown, unknown>): UserInteractionEvent {
  const run = instance.getSnapshot().run;
  if (run?.pending === undefined) throw new Error('The recovery graph did not pause.');
  return { instanceId: instance.instanceId, runId: run.runId, ...run.pending, ...answer };
}

async function paused(fixture: Fixture): Promise<UserInteractionEvent> {
  await fixture.instance.start({});
  await vi.waitFor(() => expect(fixture.instance.getSnapshot().run?.status).toBe('waiting_input'));
  return event(fixture.instance);
}

async function finished(fixture: Fixture): Promise<void> {
  await vi.waitFor(() => expect(fixture.instance.getSnapshot().run?.status).toBe('succeeded'));
  await fixture.runtime.dispose();
  const state = await fixture.graph.getState({
    configurable: { thread_id: fixture.instance.sessionId },
  });
  expect(state.values).toMatchObject({
    answer: answer.payload,
    applications: 1,
    receipts: [{ saved: 'first' }],
  });
  expect(state.next).toEqual([]);
}

test.each(modes)(
  '%s reuses a succeeded write after a crash before the resume checkpoint',
  async (mode) => {
    const store = new MemoryRecoveryStore();
    const saver = new MemorySaver();
    const held = gate();
    const entered = gate();
    const first = await fixture(mode, saver, store, {
      afterWrite: async (signal) => {
        entered.resolve();
        await held.promise;
        if (signal.aborted) throw new Error('The simulated page closed.');
      },
    });
    await first.instance.dispatch(await paused(first));
    await entered.promise;
    expect([...store.journal.values()][0]?.status).toBe('succeeded');
    const disposal = first.runtime.dispose();
    held.resolve();
    await disposal;
    const restored = await fixture(mode, saver, store, {}, first.instance.sessionId);
    expect(await restored.instance.restore()).toBeDefined();
    await finished(restored);
    expect(first.writes).toHaveLength(1);
    expect(restored.writes).toHaveLength(0);
    expect((await store.submissions(first.instance.sessionId))[0]?.status).toBe('consumed');
  },
);

test.each(modes)(
  '%s restores an unaccepted interrupt and rejects a double click after reload',
  async (mode) => {
    const store = new MemoryRecoveryStore();
    const saver = new MemorySaver();
    const held = gate();
    const entered = gate();
    const accept = vi.spyOn(store, 'acceptSubmission').mockImplementation(async () => {
      entered.resolve();
      await held.promise;
      throw new Error('The acceptance transaction was aborted.');
    });
    const first = await fixture(mode, saver, store);
    const submitted = await paused(first);
    const receipt = first.instance.dispatch(submitted);
    await entered.promise;
    const disposal = first.runtime.dispose();
    held.resolve();
    await receipt;
    await disposal;
    accept.mockRestore();
    expect(await store.submissions(first.instance.sessionId)).toEqual([]);
    const restored = await fixture(mode, saver, store, {}, first.instance.sessionId);
    await restored.instance.restore();
    expect(restored.instance.getSnapshot().run?.pending).toEqual({
      interactionId: submitted.interactionId,
      surfaceId: submitted.surfaceId,
      viewRevision: submitted.viewRevision,
      component: 'conformance.Question/v1',
      props: { question: 'Continue?' },
    });
    const next = event(restored.instance);
    const accepted = restored.instance.dispatch(next);
    expect(await restored.instance.dispatch(next)).toMatchObject({
      status: 'rejected',
      error: { code: 'duplicate' },
    });
    expect(await accepted).toMatchObject({ status: 'accepted' });
    await finished(restored);
    expect(first.writes).toHaveLength(0);
    expect(restored.writes).toHaveLength(1);
  },
);

test.each(modes)(
  '%s automatically resumes an accepted answer after a crash before resume',
  async (mode) => {
    const store = new MemoryRecoveryStore();
    const saver = new MemorySaver();
    const held = gate();
    const entered = gate();
    const accept = store.acceptSubmission.bind(store);
    const intercept = vi.spyOn(store, 'acceptSubmission').mockImplementation(async (...args) => {
      const result = await accept(...args);
      entered.resolve();
      await held.promise;
      return result;
    });
    const first = await fixture(mode, saver, store);
    const submitted = await paused(first);
    const receipt = first.instance.dispatch(submitted);
    expect(await first.instance.dispatch(submitted)).toMatchObject({
      status: 'rejected',
      error: { code: 'duplicate' },
    });
    await entered.promise;
    const disposal = first.runtime.dispose();
    held.resolve();
    expect(await receipt).toMatchObject({ status: 'rejected', error: { code: 'stale' } });
    await disposal;
    intercept.mockRestore();
    const restored = await fixture(mode, saver, store, {}, first.instance.sessionId);
    const resumed = await restored.instance.restore();
    expect(resumed).toBeDefined();
    expect(restored.instance.getSnapshot().run?.status).toBe('running');
    expect(
      await restored.instance.dispatch({
        ...submitted,
        instanceId: restored.instance.instanceId,
        runId: resumed?.runId as UserInteractionEvent['runId'],
      }),
    ).toMatchObject({ status: 'rejected', error: { code: 'duplicate' } });
    await finished(restored);
    expect(first.writes).toHaveLength(0);
    expect(restored.writes).toHaveLength(1);
  },
);

test.each(modes)(
  '%s consumes an accepted answer after a crash following its resume checkpoint',
  async (mode) => {
    const store = new MemoryRecoveryStore();
    const saver = new MemorySaver();
    const held = gate();
    const entered = gate();
    const intercept = vi.spyOn(store, 'consumeSubmission').mockImplementation(async () => {
      entered.resolve();
      await held.promise;
      throw new Error('The consumption transaction was aborted.');
    });
    const first = await fixture(mode, saver, store);
    await first.instance.dispatch(await paused(first));
    await entered.promise;
    const state = await first.graph.getState({
      configurable: { thread_id: first.instance.sessionId },
    });
    expect(state.next).toEqual([]);
    expect(state.values).toMatchObject({ applications: 1, answer: answer.payload });
    const disposal = first.runtime.dispose();
    held.resolve();
    await disposal;
    intercept.mockRestore();
    expect((await store.submissions(first.instance.sessionId))[0]?.status).toBe('accepted');
    const restored = await fixture(mode, saver, store, {}, first.instance.sessionId);
    expect(await restored.instance.restore()).toBeUndefined();
    expect(restored.instance.getSnapshot().run).toBeUndefined();
    expect((await store.submissions(first.instance.sessionId))[0]?.status).toBe('consumed');
    expect(first.writes).toHaveLength(1);
    expect(restored.writes).toHaveLength(0);
  },
);

test.each(modes)('%s keeps the duplicate receipt after consumption and a reload', async (mode) => {
  const store = new MemoryRecoveryStore();
  const saver = new MemorySaver();
  const held = gate();
  const entered = gate();
  const consume = store.consumeSubmission.bind(store);
  const intercept = vi.spyOn(store, 'consumeSubmission').mockImplementation(async (...args) => {
    await consume(...args);
    entered.resolve();
    await held.promise;
  });
  const first = await fixture(mode, saver, store);
  const submitted = await paused(first);
  await first.instance.dispatch(submitted);
  await entered.promise;
  expect((await store.submissions(first.instance.sessionId))[0]?.status).toBe('consumed');
  expect(await first.instance.dispatch(submitted)).toMatchObject({
    status: 'rejected',
    error: { code: 'duplicate' },
  });
  const disposal = first.runtime.dispose();
  held.resolve();
  await disposal;
  intercept.mockRestore();
  const restored = await fixture(mode, saver, store, {}, first.instance.sessionId);
  expect(await restored.instance.restore()).toBeUndefined();
  // With no pending interrupt restore has no run; the durable receipt still refuses insertion.
  expect(
    await store.acceptSubmission(first.instance.sessionId, {
      interactionId: submitted.interactionId,
      ...answer,
    }),
  ).toBe('duplicate');
  const state = await restored.graph.getState({
    configurable: { thread_id: first.instance.sessionId },
  });
  expect(state.values).toMatchObject({ answer: answer.payload, applications: 1 });
  expect(restored.writes).toHaveLength(0);
});

test.each(
  modes.flatMap((mode) => (['none', 'idempotency-key'] as const).map((retry) => ({ mode, retry }))),
)('$mode replays a dispatched write only under retry $retry', async ({ mode, retry }) => {
  const store = new MemoryRecoveryStore();
  const saver = new MemorySaver();
  const held = gate();
  const entered = gate();
  const first = await fixture(mode, saver, store, {
    retry,
    invoke: async (_input, context) => {
      entered.resolve();
      await held.promise;
      if (context.signal.aborted) throw new Error('The earlier write outcome is unknown.');
      return { saved: 'first' };
    },
  });
  await first.instance.dispatch(await paused(first));
  await entered.promise;
  expect([...store.journal.values()][0]?.status).toBe('dispatched');
  const disposal = first.runtime.dispose();
  held.resolve();
  await disposal;
  const restored = await fixture(mode, saver, store, { retry }, first.instance.sessionId);
  await restored.instance.restore();
  if (retry === 'none') {
    await vi.waitFor(() =>
      expect(restored.instance.getSnapshot().run?.error?.code).toBe('outcome_unknown'),
    );
    expect(restored.writes).toHaveLength(0);
    expect(restored.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: 'effect_outcome_unknown',
        effectId: first.writes[0]?.effectId,
      }),
    );
  } else {
    await finished(restored);
    expect(restored.writes).toHaveLength(1);
    expect(restored.writes[0]?.effectId).toBe(first.writes[0]?.effectId);
  }
  expect(first.writes).toHaveLength(1);
});

test.each(modes)('%s repeats reads while reusing writes after a failed resume', async (mode) => {
  const store = new MemoryRecoveryStore();
  const saver = new MemorySaver();
  const first = await fixture(mode, saver, store, {
    read: true,
    afterWrite: async () => {
      throw new Error('The graph failed before committing.');
    },
  });
  await first.instance.dispatch(await paused(first));
  await vi.waitFor(() => expect(first.instance.getSnapshot().run?.status).toBe('failed'));
  await first.runtime.dispose();
  expect((await store.submissions(first.instance.sessionId))[0]?.status).toBe('accepted');
  expect([...store.journal.values()]).toHaveLength(1);
  const restored = await fixture(mode, saver, store, { read: true }, first.instance.sessionId);
  await restored.instance.restore();
  await finished(restored);
  expect(first.writes).toHaveLength(1);
  expect(restored.writes).toHaveLength(0);
  expect(first.reads).toHaveLength(1);
  expect(restored.reads).toHaveLength(1);
  expect(first.reads[0]?.effectId).not.toBe(restored.reads[0]?.effectId);
  expect([...store.journal.values()]).toHaveLength(1);
});

test.each(modes)('%s refuses changed write order on replay', async (mode) => {
  const store = new MemoryRecoveryStore();
  const saver = new MemorySaver();
  const first = await fixture(mode, saver, store, {
    inputs: ['first', 'second'],
    afterWrite: async () => {
      throw new Error('The graph failed before committing.');
    },
  });
  await first.instance.dispatch(await paused(first));
  await vi.waitFor(() => expect(first.instance.getSnapshot().run?.status).toBe('failed'));
  await first.runtime.dispose();
  const restored = await fixture(
    mode,
    saver,
    store,
    { inputs: ['second', 'first'] },
    first.instance.sessionId,
  );
  await restored.instance.restore();
  await vi.waitFor(() =>
    expect(restored.instance.getSnapshot().run?.error?.code).toBe('unrecoverable'),
  );
  expect(first.writes).toHaveLength(2);
  expect(restored.writes).toHaveLength(0);
});

async function open(databaseName: string): Promise<IndexedDBSaver> {
  if (!databases.includes(databaseName)) databases.push(databaseName);
  const saver = await IndexedDBSaver.open({
    databaseName,
    appId: 'recovery-conformance',
    principalScope: 'conformance',
  });
  savers.push(saver);
  return saver;
}

test.skipIf(typeof indexedDB === 'undefined').each(modes)(
  '%s reopens the IndexedDB inbox and write journal before replaying an accepted answer',
  async (mode) => {
    const databaseName = `galaxie-recovery-${crypto.randomUUID()}`;
    const saver = await open(databaseName);
    const held = gate();
    const entered = gate();
    const first = await fixture(mode, saver, saver.recovery, {
      afterWrite: async (signal) => {
        entered.resolve();
        await held.promise;
        if (signal.aborted) throw new Error('The simulated page closed.');
      },
    });
    const submitted = await paused(first);
    await first.instance.dispatch(submitted);
    await entered.promise;
    const disposal = first.runtime.dispose();
    held.resolve();
    await disposal;
    saver.close();
    const reopened = await open(databaseName);
    expect((await reopened.recovery.submissions(first.instance.sessionId))[0]?.status).toBe(
      'accepted',
    );
    const effectId = first.writes[0]?.effectId;
    if (effectId === undefined) throw new Error('The write effect ID is missing.');
    expect(await reopened.recovery.effect(first.instance.sessionId, effectId)).toMatchObject({
      status: 'succeeded',
      output: { saved: 'first' },
    });
    const restored = await fixture(mode, reopened, reopened.recovery, {}, first.instance.sessionId);
    await restored.instance.restore();
    await finished(restored);
    expect(first.writes).toHaveLength(1);
    expect(restored.writes).toHaveLength(0);
    reopened.close();
    const completed = await open(databaseName);
    expect((await completed.recovery.submissions(first.instance.sessionId))[0]?.status).toBe(
      'consumed',
    );
    expect(
      await completed.recovery.acceptSubmission(first.instance.sessionId, {
        interactionId: submitted.interactionId,
        ...answer,
      }),
    ).toBe('duplicate');
  },
);
