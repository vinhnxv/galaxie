// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter, requestInteraction } from '@galaxie-ai/adapter-langgraph';
import {
  type AgentInstance,
  type CapabilityContext,
  createRuntime,
  type EffectId,
  type EffectRecord,
  type RecoverySession,
  type RecoverySubmission,
  type SessionId,
  type UserInteractionEvent,
} from '@galaxie-ai/core';
import { IndexedDBSaver } from '@galaxie-ai/storage-indexeddb';
import {
  Annotation,
  type BaseCheckpointSaver,
  END,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph/web';
import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import {
  openDatabase,
  requestResult,
  transact,
} from '../../packages/storage-indexeddb/src/schema.js';
import { assistantRoles, assistantRouting } from './support/routing.js';
import { waitForRunStatus } from './support/run-status.js';
import { ScriptedChatModel } from './support/scripted-chat-model.js';
import type { ConformanceGraph } from './support/transcript.js';

const appId = 'recovery-format-conformance';
const principalScope = 'conformance';
const identity = {
  agentId: 'conformance/recovery-format',
  agentVersion: '1.0.0',
  executorId: 'langgraph-js',
};
const answer = { action: 'submit', payload: { answer: 'once' } } as const;
// SHA-256 of the JSON string "first", shared by the literal legacy receipts below.
const inputDigest = 'de5f2cbf4c10a0d146f2a671aac363e8640fefc469ad42ac25364f19e4bc194f';
const runtimes: Array<{ dispose(): Promise<void> }> = [];
const savers: IndexedDBSaver[] = [];
const databases: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const saver of savers.splice(0)) saver.close();
  for (const name of databases.splice(0)) await requestResult(indexedDB.deleteDatabase(name));
});

type Store =
  | { kind: 'memory'; saver: MemorySaver; recovery: MemoryRecoveryStore }
  | {
      kind: 'indexeddb';
      saver: IndexedDBSaver;
      recovery: IndexedDBSaver['recovery'];
      databaseName: string;
    };

async function storage(kind: Store['kind'], databaseName?: string): Promise<Store> {
  if (kind === 'memory')
    return { kind, saver: new MemorySaver(), recovery: new MemoryRecoveryStore() };
  const name = databaseName ?? `galaxie-recovery-format-${crypto.randomUUID()}`;
  if (!databases.includes(name)) databases.push(name);
  const saver = await IndexedDBSaver.open({ databaseName: name, appId, principalScope });
  savers.push(saver);
  return { kind, saver, recovery: saver.recovery, databaseName: name };
}

async function reopen(store: Store): Promise<Store> {
  if (store.kind === 'memory') return store;
  store.saver.close();
  return storage('indexeddb', store.databaseName);
}

async function seed(
  store: Store,
  sessionId: SessionId,
  session: RecoverySession,
  submission?: RecoverySubmission,
  receipt?: { id: EffectId; record: EffectRecord },
): Promise<void> {
  if (store.kind === 'memory') {
    store.recovery.sessions.set(sessionId, structuredClone(session));
    if (submission !== undefined)
      store.recovery.inbox.set(
        JSON.stringify([sessionId, submission.interactionId]),
        structuredClone(submission),
      );
    if (receipt !== undefined)
      store.recovery.journal.set(
        JSON.stringify([sessionId, receipt.id]),
        structuredClone(receipt.record),
      );
    return;
  }
  const db = await openDatabase(store.databaseName, appId, principalScope);
  try {
    await transact(db, ['meta', 'inbox', 'journal'], 'readwrite', async (tx) => {
      await requestResult(
        tx
          .objectStore('meta')
          .put({ v: 1, value: session }, [appId, principalScope, 'session', sessionId]),
      );
      if (submission !== undefined)
        await requestResult(
          tx
            .objectStore('inbox')
            .put({ v: 1, value: submission }, [
              appId,
              principalScope,
              sessionId,
              submission.interactionId,
            ]),
        );
      if (receipt !== undefined)
        await requestResult(
          tx
            .objectStore('journal')
            .put({ v: 1, value: receipt.record }, [appId, principalScope, sessionId, receipt.id]),
        );
    });
  } finally {
    db.close();
  }
}

async function records(store: Store): Promise<{
  sessions: unknown[];
  submissions: unknown[];
  effects: unknown[];
}> {
  if (store.kind === 'memory')
    return structuredClone({
      sessions: [...store.recovery.sessions.values()],
      submissions: [...store.recovery.inbox.values()],
      effects: [...store.recovery.journal.values()],
    });
  const db = await openDatabase(store.databaseName, appId, principalScope);
  try {
    return await transact(db, ['meta', 'inbox', 'journal'], 'readonly', async (tx) => {
      const sessionRows: Array<{ v: number; value: unknown }> = await requestResult(
        tx
          .objectStore('meta')
          .getAll(
            IDBKeyRange.bound(
              [appId, principalScope, 'session'],
              [appId, principalScope, 'session', []],
              false,
              true,
            ),
          ),
      );
      const submissionRows: Array<{ v: number; value: unknown }> = await requestResult(
        tx.objectStore('inbox').getAll(),
      );
      const effectRows: Array<{ v: number; value: unknown }> = await requestResult(
        tx.objectStore('journal').getAll(),
      );
      for (const row of [...sessionRows, ...submissionRows, ...effectRows]) expect(row.v).toBe(1);
      return {
        sessions: sessionRows.map((row) => row.value),
        submissions: submissionRows.map((row) => row.value),
        effects: effectRows.map((row) => row.value),
      };
    });
  } finally {
    db.close();
  }
}

async function fixture(store: Store, sessionId?: SessionId, failAfterWrite = false) {
  const writes: CapabilityContext[] = [];
  const runtime = createRuntime({ appId, executors: [createLangGraphAdapter()] });
  runtimes.push(runtime);
  let graph: ConformanceGraph | undefined;
  const instance = await runtime.create(
    {
      id: identity.agentId,
      version: identity.agentVersion,
      executor: identity.executorId,
      input: z.object({}),
      models: assistantRoles,
      capabilities: {
        required: {
          'save@1': { kind: 'write', input: z.string(), output: z.object({ saved: z.string() }) },
        },
      },
    },
    {
      principalScope,
      recovery: store.recovery,
      ...(sessionId === undefined ? {} : { sessionId }),
      models: assistantRouting(),
      services: { checkpointer: store.saver, chatModels: { assistant: new ScriptedChatModel({}) } },
      bindings: {
        'save@1': {
          kind: 'write',
          destination: 'in-browser',
          timeoutMs: 10000,
          concurrency: 1,
          grantScope: 'instance',
          approval: 'none',
          retry: 'none',
          invoke: async (input, context) => {
            writes.push(context);
            return { saved: input };
          },
        },
      },
      agent: (host) => {
        const state = Annotation.Root({
          answer: Annotation<unknown>,
          receipt: Annotation<unknown>,
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
            const receipt = await host.capabilities.call('save@1', 'first', config);
            if (failAfterWrite) throw new Error('The graph failed before committing the resume.');
            return { answer: submitted.payload, receipt };
          })
          .addEdge(START, 'ask')
          .addEdge('ask', END)
          .compile({ checkpointer: host.langchain.checkpointer() })
          .withConfig({ durability: 'sync' });
        return graph;
      },
    },
  );
  await instance.prepare();
  if (graph === undefined) throw new Error('The recovery format graph was not prepared.');
  return { runtime, instance, graph, writes };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function event(instance: AgentInstance<unknown, unknown>): UserInteractionEvent {
  const run = instance.getSnapshot().run;
  if (run?.pending === undefined) throw new Error('The recovery format graph did not pause.');
  return { instanceId: instance.instanceId, runId: run.runId, ...run.pending, ...answer };
}

async function paused(fixture: Fixture): Promise<UserInteractionEvent> {
  await fixture.instance.start({});
  await waitForRunStatus(fixture.instance, 'waiting_input');
  return event(fixture.instance);
}

async function finished(fixture: Fixture, saved = 'first'): Promise<void> {
  await waitForRunStatus(fixture.instance, 'succeeded');
  await fixture.runtime.dispose();
  const state = await fixture.graph.getState({
    configurable: { thread_id: fixture.instance.sessionId },
  });
  expect(state.values).toEqual({ answer: answer.payload, receipt: { saved } });
  expect(state.next).toEqual([]);
}

async function checkpoints(saver: BaseCheckpointSaver, sessionId: SessionId): Promise<unknown[]> {
  const tuples: unknown[] = [];
  for await (const tuple of saver.list({ configurable: { thread_id: sessionId } }))
    tuples.push(tuple);
  return tuples;
}

for (const kind of ['memory', 'indexeddb'] as const) {
  describe.skipIf(kind === 'indexeddb' && typeof indexedDB === 'undefined')(
    `${kind} recovery format`,
    () => {
      test.each([false, true])(
        'restores literal 0.1.0 records with a succeeded receipt: %s',
        async (hasReceipt) => {
          const store = await storage(kind);
          const first = await fixture(store, undefined, hasReceipt);
          const submitted = await paused(first);
          if (hasReceipt) {
            expect(await first.instance.dispatch(submitted)).toMatchObject({ status: 'accepted' });
            await waitForRunStatus(first.instance, 'failed');
          }
          await first.runtime.dispose();
          expect(first.writes).toHaveLength(hasReceipt ? 1 : 0);
          const sessionId = first.instance.sessionId;
          const submission: RecoverySubmission = {
            interactionId: submitted.interactionId,
            action: 'submit',
            payload: { answer: 'once' },
            status: 'accepted',
          };
          const effectId = first.writes[0]?.effectId;
          if (hasReceipt && effectId === undefined)
            throw new Error('The write effect ID is missing.');
          const receipt =
            effectId === undefined
              ? undefined
              : {
                  id: effectId,
                  record: {
                    status: 'succeeded',
                    inputDigest,
                    output: { saved: 'legacy receipt' },
                  } as const,
                };
          await seed(store, sessionId, identity, submission, receipt);
          expect(await records(store)).toEqual({
            sessions: [identity],
            submissions: [submission],
            effects: receipt === undefined ? [] : [receipt.record],
          });
          const reopened = await reopen(store);
          const restored = await fixture(reopened, sessionId);
          expect(await restored.instance.restore()).toBeDefined();
          await finished(restored, hasReceipt ? 'legacy receipt' : 'first');
          expect(restored.writes).toHaveLength(hasReceipt ? 0 : 1);
          const saved = await records(reopened);
          expect(saved.sessions).toEqual([identity]);
          expect(saved.submissions).toEqual([{ ...submission, status: 'consumed' }]);
          if (receipt !== undefined) expect(saved.effects).toEqual([receipt.record]);
        },
      );

      test('stamps raw session, submission and effect records with format version 1', async () => {
        const store = await storage(kind);
        const current = await fixture(store);
        const submitted = await paused(current);
        expect(await current.instance.dispatch(submitted)).toMatchObject({ status: 'accepted' });
        await finished(current);
        const reopened = await reopen(store);
        expect(await records(reopened)).toEqual({
          sessions: [{ ...identity, formatVersion: 1 }],
          submissions: [
            {
              formatVersion: 1,
              interactionId: submitted.interactionId,
              ...answer,
              status: 'consumed',
            },
          ],
          effects: [
            { formatVersion: 1, status: 'succeeded', inputDigest, output: { saved: 'first' } },
          ],
        });
        expect(current.writes).toHaveLength(1);
      });

      test('refuses a newer session without changing checkpoints or invoking the host', async () => {
        const store = await storage(kind);
        const first = await fixture(store);
        await paused(first);
        await first.runtime.dispose();
        const sessionId = first.instance.sessionId;
        await seed(store, sessionId, { ...identity, formatVersion: 2 });
        const reopened = await reopen(store);
        const before = await checkpoints(reopened.saver, sessionId);
        expect(before.length).toBeGreaterThan(0);
        const saved = await records(reopened);
        const restored = await fixture(reopened, sessionId);
        const error: unknown = await restored.instance.restore().catch((error: unknown) => error);
        expect(error).toMatchObject({ code: 'unrecoverable' });
        if (reopened.kind === 'memory') {
          expect(error).toMatchObject({
            message: 'The saved session uses an unsupported recovery format.',
          });
        } else {
          await expect(reopened.recovery.session(sessionId)).rejects.toMatchObject({
            code: 'newer_record',
            message: 'The recovery record format is newer than this package supports.',
            unrecoverable: true,
          });
        }
        expect(restored.instance.getSnapshot().run).toBeUndefined();
        expect(first.writes).toHaveLength(0);
        expect(restored.writes).toHaveLength(0);
        expect(await checkpoints(reopened.saver, sessionId)).toEqual(before);
        expect(await records(reopened)).toEqual(saved);
      });
    },
  );
}

test.skipIf(typeof indexedDB === 'undefined')(
  'refuses a newer IndexedDB receipt on the capability path without invoking or overwriting',
  async () => {
    const store = await storage('indexeddb');
    const first = await fixture(store, undefined, true);
    const submitted = await paused(first);
    expect(await first.instance.dispatch(submitted)).toMatchObject({ status: 'accepted' });
    await waitForRunStatus(first.instance, 'failed');
    await first.runtime.dispose();
    expect(first.writes).toHaveLength(1);
    const effectId = first.writes[0]?.effectId;
    if (effectId === undefined) throw new Error('The write effect ID is missing.');
    const sessionId = first.instance.sessionId;
    const receipt: EffectRecord = {
      formatVersion: 2,
      status: 'succeeded',
      inputDigest,
      output: { saved: 'newer receipt' },
    };
    await seed(store, sessionId, { ...identity, formatVersion: 1 }, undefined, {
      id: effectId,
      record: receipt,
    });
    const reopened = await reopen(store);
    await expect(reopened.recovery.effect(sessionId, effectId)).rejects.toMatchObject({
      code: 'newer_record',
      unrecoverable: true,
    });
    const restored = await fixture(reopened, sessionId);
    expect(await restored.instance.restore()).toBeDefined();
    await waitForRunStatus(restored.instance, 'failed');
    expect(restored.instance.getSnapshot().run?.error).toMatchObject({ code: 'unavailable' });
    expect(restored.writes).toHaveLength(0);
    await restored.runtime.dispose();
    expect((await records(reopened)).effects).toEqual([receipt]);
  },
);
