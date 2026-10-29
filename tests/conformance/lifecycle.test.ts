// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter, requestInteraction } from '@galaxie/adapter-langgraph';
import {
  createRuntime,
  type DiagnosticEvent,
  type RecoveryStore,
  type SessionId,
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
import { prefixRange } from '../../packages/storage-indexeddb/src/keys.js';
import {
  openDatabase,
  requestResult,
  transact,
} from '../../packages/storage-indexeddb/src/schema.js';
import { assistantRoles, assistantRouting } from './support/routing.js';
import { ScriptedChatModel } from './support/scripted-chat-model.js';

const appId = 'lifecycle-conformance';
const principalScope = 'learner';
const runtimes: Array<{ dispose(): Promise<void> }> = [];
const savers: IndexedDBSaver[] = [];
const databases: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const saver of savers.splice(0)) saver.close();
  for (const name of databases.splice(0)) await requestResult(indexedDB.deleteDatabase(name));
});

async function fixture(
  saver: BaseCheckpointSaver,
  recovery?: RecoveryStore,
  sessionId?: SessionId,
) {
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId,
    executors: [createLangGraphAdapter()],
    diagnostics: (event) => diagnostics.push(event),
  });
  runtimes.push(runtime);
  const instance = await runtime.create(
    {
      id: 'conformance/storage-lifecycle',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({}),
      models: assistantRoles,
    },
    {
      principalScope,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(recovery === undefined ? {} : { recovery }),
      services: { checkpointer: saver, chatModels: { assistant: new ScriptedChatModel({}) } },
      models: assistantRouting(),
      agent: (host) =>
        new StateGraph(Annotation.Root({ answer: Annotation<unknown> }))
          .addNode('ask', (_state, config) => ({
            answer: requestInteraction(
              {
                surfaceId: 'main',
                viewRevision: 'r1',
                component: 'conformance.Question/v1',
                props: { question: 'Continue?' },
              },
              config,
            ).payload,
          }))
          .addEdge(START, 'ask')
          .addEdge('ask', END)
          .compile({ checkpointer: host.langchain.checkpointer() })
          .withConfig({ durability: 'sync' }),
    },
  );
  await instance.prepare();
  return { runtime, instance, diagnostics };
}

async function open(databaseName: string): Promise<IndexedDBSaver> {
  if (!databases.includes(databaseName)) databases.push(databaseName);
  const saver = await IndexedDBSaver.open({ databaseName, appId, principalScope });
  savers.push(saver);
  return saver;
}

async function stored(databaseName: string): Promise<unknown[]> {
  const db = await openDatabase(databaseName, appId, principalScope);
  try {
    return await transact(
      db,
      ['checkpoints', 'writes', 'inbox', 'journal', 'meta'],
      'readonly',
      async (tx) => {
        const result: unknown[] = [];
        for (const name of ['checkpoints', 'writes', 'inbox', 'journal', 'meta']) {
          const store = tx.objectStore(name);
          const range = prefixRange([appId, principalScope]);
          result.push([
            name,
            await requestResult(store.getAllKeys(range)),
            await requestResult(store.getAll(range)),
          ]);
        }
        return result;
      },
    );
  } finally {
    db.close();
  }
}

test('the real adapter maps a marked checkpoint write failure to unrecoverable', async () => {
  const saver = new MemorySaver();
  const failure = Object.assign(new Error('private-checkpoint-canary'), { unrecoverable: true });
  vi.spyOn(saver, 'put').mockRejectedValue(failure);
  const { instance, diagnostics } = await fixture(saver);
  const { runId } = await instance.start({});
  await vi.waitFor(() => expect(instance.getSnapshot().run?.status).toBe('failed'));
  expect(instance.getSnapshot().run?.error?.code).toBe('unrecoverable');
  expect(JSON.stringify(instance.getSnapshot())).not.toContain('private-checkpoint-canary');
  const errors = [];
  for await (const event of instance.events(runId))
    if (event.type === 'error') errors.push(event.error);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    code: 'unrecoverable',
    message: 'Stored state cannot be recovered.',
  });
  expect(JSON.stringify(errors)).not.toContain('private-checkpoint-canary');
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ kind: 'run_failed', error: failure }),
  );
});

test.skipIf(typeof indexedDB === 'undefined')(
  'corrupt checkpoints refuse restore and remain until explicit session deletion',
  async () => {
    const name = `galaxie-lifecycle-corrupt-${crypto.randomUUID()}`;
    const saver = await open(name);
    const first = await fixture(saver, saver.recovery);
    await first.instance.start({});
    await vi.waitFor(() => expect(first.instance.getSnapshot().run?.status).toBe('waiting_input'));
    const sessionId = first.instance.sessionId;
    await first.runtime.dispose();
    saver.close();
    const db = await openDatabase(name, appId, principalScope);
    try {
      await transact(db, ['checkpoints'], 'readwrite', async (tx) => {
        const store = tx.objectStore('checkpoints');
        const cursor = await requestResult(
          store.openCursor(prefixRange([appId, principalScope, sessionId, '']), 'prev'),
        );
        if (cursor === null) throw new Error('The lifecycle checkpoint is missing.');
        const value = cursor.value;
        value.checkpoint = { v: 99, type: 'json', bytes: new Uint8Array() };
        await requestResult(cursor.update(value));
      });
    } finally {
      db.close();
    }
    const before = await stored(name);
    const reopened = await open(name);
    const restored = await fixture(reopened, reopened.recovery, sessionId);
    await expect(restored.instance.restore()).rejects.toMatchObject({
      code: 'unrecoverable',
      message: 'Stored state cannot be recovered.',
    });
    expect(restored.instance.getSnapshot().run).toBeUndefined();
    expect(restored.diagnostics).toContainEqual(
      expect.objectContaining({ kind: 'restore_failed' }),
    );
    expect(await stored(name)).toEqual(before);
    await reopened.deleteSession(sessionId);
    expect(await reopened.getTuple({ configurable: { thread_id: sessionId } })).toBeUndefined();
    expect(await reopened.recovery.session(sessionId)).toBeUndefined();
    expect(await reopened.recovery.submissions(sessionId)).toEqual([]);
  },
);

test.skipIf(typeof indexedDB === 'undefined')(
  'an incompatible recorded agent version refuses restore without deleting data',
  async () => {
    const name = `galaxie-lifecycle-version-${crypto.randomUUID()}`;
    const saver = await open(name);
    const first = await fixture(saver, saver.recovery);
    await first.instance.start({});
    await vi.waitFor(() => expect(first.instance.getSnapshot().run?.status).toBe('waiting_input'));
    const sessionId = first.instance.sessionId;
    await first.runtime.dispose();
    saver.close();
    const db = await openDatabase(name, appId, principalScope);
    try {
      await transact(db, ['meta'], 'readwrite', async (tx) => {
        const store = tx.objectStore('meta');
        const key = [appId, principalScope, 'session', sessionId];
        await requestResult(
          store.put(
            { v: 1, value: { agentId: 'conformance/storage-lifecycle', agentVersion: '2.0.0' } },
            key,
          ),
        );
      });
    } finally {
      db.close();
    }
    const before = await stored(name);
    const reopened = await open(name);
    const restored = await fixture(reopened, reopened.recovery, sessionId);
    await expect(restored.instance.restore()).rejects.toMatchObject({
      code: 'unsupported',
      message: 'The saved session uses an unsupported agent version.',
    });
    expect(restored.instance.getSnapshot().run).toBeUndefined();
    expect(restored.diagnostics).toContainEqual(
      expect.objectContaining({ kind: 'restore_failed' }),
    );
    expect(await stored(name)).toEqual(before);
  },
);
