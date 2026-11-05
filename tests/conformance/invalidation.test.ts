// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter, requestInteraction } from '@galaxie/adapter-langgraph';
import { acquireOwnership, createRuntime, type Ownership, watchInvalidation } from '@galaxie/core';
import { IndexedDBSaver } from '@galaxie/storage-indexeddb';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { prefixRange } from '../../packages/storage-indexeddb/src/keys.js';
import {
  openDatabase,
  requestResult,
  transact,
} from '../../packages/storage-indexeddb/src/schema.js';
import { assistantRoles, assistantRouting } from './support/routing.js';
import { ScriptedChatModel } from './support/scripted-chat-model.js';

const runtimes: Array<{ dispose(): Promise<void> }> = [];
const savers: IndexedDBSaver[] = [];
const owners: Ownership[] = [];
const watchers: Array<{ close(): void }> = [];
const databases: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(owners.splice(0).map((owner) => owner.release()));
  for (const watcher of watchers.splice(0)) watcher.close();
  for (const saver of savers.splice(0)) saver.close();
  for (const name of databases.splice(0)) await requestResult(indexedDB.deleteDatabase(name));
});

describe.skipIf(typeof indexedDB === 'undefined')('AT-13 principal logout', () => {
  test.each([true, false])(
    'wipes a paused graph and rejects late writes; notice delivered=%s',
    async (deliver) => {
      const appId = crypto.randomUUID();
      const databaseName = `galaxie-invalidation-${appId}`;
      databases.push(databaseName);
      const options = { appId, principalScope: 'learner', databaseName };
      const a = await IndexedDBSaver.open(options);
      const b = await IndexedDBSaver.open(options);
      savers.push(a, b);
      const noticeA = watchInvalidation(options);
      const noticeB = watchInvalidation(options);
      watchers.push(noticeA, noticeB);
      const runtime = createRuntime({ appId, executors: [createLangGraphAdapter()] });
      runtimes.push(runtime);
      const instance = await runtime.create(
        {
          id: 'conformance/invalidation',
          version: '1.0.0',
          executor: 'langgraph-js',
          input: z.object({}),
          models: assistantRoles,
        },
        {
          principalScope: 'learner',
          recovery: a.recovery,
          models: assistantRouting(),
          services: { checkpointer: a, chatModels: { assistant: new ScriptedChatModel({}) } },
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
      const acquired = await acquireOwnership({
        appId,
        fence: a.fencing,
        onHandoverRequest: () => runtime.dispose(),
      });
      if (acquired.status !== 'owner') throw new Error('The expected owner was busy.');
      const owner = acquired.ownership;
      owners.push(owner);
      await instance.prepare();
      const { runId } = await instance.start({});
      await vi.waitFor(() => expect(instance.getSnapshot().run?.status).toBe('waiting_input'));
      const pending = instance.getSnapshot().run?.pending;
      if (!pending) throw new Error('The graph did not pause.');
      await a.recovery.acceptSubmission(instance.sessionId, {
        interactionId: 'earlier',
        action: 'submit',
        payload: 'private answer',
      });
      await a.recovery.recordEffect(instance.sessionId, 'earlier-effect', {
        status: 'dispatched',
        inputDigest: 'a'.repeat(64),
      });
      // B never owns the app. The shared meta store serializes logout with every A mutation.
      await b.invalidatePrincipal();
      if (deliver) {
        noticeB.announce();
        await vi.waitFor(() => expect(noticeA.signal.reason).toBe('invalidated'));
      } else expect(noticeA.signal.aborted).toBe(false);
      await expect(
        a.recovery.recordEffect(instance.sessionId, 'late-effect', {
          status: 'succeeded',
          inputDigest: 'a'.repeat(64),
          output: 'late private reply',
        }),
      ).rejects.toMatchObject({ code: 'invalidated' });
      expect(
        await instance.dispatch({
          instanceId: instance.instanceId,
          runId,
          ...pending,
          action: 'submit',
          payload: false,
        }),
      ).toMatchObject({ status: 'rejected', error: { code: 'stale' } });
      globalThis.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      await vi.waitFor(() => expect(owner.signal.reason).toBe('stale'));
      await instance.dispose();
      await runtime.dispose();
      const db = await openDatabase(databaseName, appId, 'learner');
      try {
        await transact(
          db,
          ['checkpoints', 'writes', 'inbox', 'journal', 'meta'],
          'readonly',
          async (tx) => {
            const range = prefixRange([appId, 'learner']);
            for (const name of ['checkpoints', 'writes', 'inbox', 'journal'])
              expect(await requestResult(tx.objectStore(name).getAllKeys(range))).toEqual([]);
            expect(await requestResult(tx.objectStore('meta').getAllKeys(range))).toEqual([
              [appId, 'learner', 'generation'],
              [appId, 'learner', 'schema'],
            ]);
            expect(await requestResult(tx.objectStore('meta').get([appId]))).toEqual({
              v: 1,
              epoch: 1,
            });
          },
        );
      } finally {
        db.close();
      }
    },
  );
});
