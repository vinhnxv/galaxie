// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter, requestInteraction } from '@galaxie/adapter-langgraph';
import { type CapabilityContext, createRuntime, type SessionId } from '@galaxie/core';
import { IndexedDBSaver } from '@galaxie/storage-indexeddb';
import {
  Annotation,
  type BaseCheckpointSaver,
  END,
  type LangGraphRunnableConfig,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph/web';
import { expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { assistantRoles, assistantRouting } from './support/routing.js';
import { ScriptedChatModel } from './support/scripted-chat-model.js';

test.each(['task-scopes', 'restore'] as const)(
  'AT-35: recovery preserves parent write receipts across %s',
  async (mode) => {
    const databaseName = `galaxie-subgraph-scopes-${crypto.randomUUID()}`;
    const savers: IndexedDBSaver[] = [];
    const runtimes: ReturnType<typeof createRuntime>[] = [];
    const open = async (): Promise<IndexedDBSaver> => {
      const saver = await IndexedDBSaver.open({
        databaseName,
        appId: 'subgraph-scopes',
        principalScope: 'test',
      });
      savers.push(saver);
      return saver;
    };
    onTestFinished(async () => {
      for (const runtime of runtimes) await runtime.dispose();
      for (const saver of savers) saver.close();
      if (savers.length > 0)
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error('Subgraph scope cleanup was blocked.'));
        });
    });
    let saver: BaseCheckpointSaver =
      typeof indexedDB === 'undefined' ? new MemorySaver() : await open();
    const memoryRecovery = new MemoryRecoveryStore();
    const writes: CapabilityContext[] = [];
    const receipts: unknown[] = [];
    let parentBodies = 0;
    const create = async (sessionId?: SessionId) => {
      const runtime = createRuntime({
        appId: 'subgraph-scopes',
        executors: [createLangGraphAdapter()],
      });
      runtimes.push(runtime);
      const instance = await runtime.create(
        {
          id: 'conformance/subgraph-scopes',
          version: '1.0.0',
          executor: 'langgraph-js',
          input: z.object({}),
          models: assistantRoles,
          capabilities: {
            required: {
              'save@1': {
                input: z.object({ value: z.literal('practice') }),
                output: z.object({ effectId: z.string().uuid() }),
                kind: 'write',
              },
            },
          },
        },
        {
          principalScope: 'test',
          ...(sessionId === undefined ? {} : { sessionId }),
          recovery: saver instanceof IndexedDBSaver ? saver.recovery : memoryRecovery,
          services: { checkpointer: saver, chatModels: { assistant: new ScriptedChatModel({}) } },
          models: assistantRouting(),
          bindings: {
            'save@1': {
              kind: 'write',
              destination: 'in-browser',
              timeoutMs: 1000,
              concurrency: 1,
              grantScope: 'instance',
              approval: 'none',
              retry: 'none',
              invoke: async (_input, context) => {
                writes.push(context);
                return { effectId: context.effectId };
              },
            },
          },
          agent: (host) => {
            const state = Annotation.Root({
              round: Annotation<number>({ default: () => 0, reducer: (_left, right) => right }),
              answer: Annotation<unknown>,
            });
            const write = async (config: LangGraphRunnableConfig): Promise<void> => {
              receipts.push(await host.capabilities.call('save@1', { value: 'practice' }, config));
            };
            const child = new StateGraph(state)
              .addNode('ask', async (_value, config) => {
                if (mode === 'task-scopes') await write(config);
                return {
                  answer: requestInteraction(
                    {
                      surfaceId: 'main',
                      viewRevision: 'r1',
                      component: 'conformance.Question/v1',
                      props: {},
                    },
                    config,
                  ).payload,
                };
              })
              .addEdge(START, 'ask')
              .addEdge('ask', END)
              .compile();
            return new StateGraph(state)
              .addNode('parent', async (value, config) => {
                parentBodies++;
                await write(config);
                if (mode === 'task-scopes') await write(config);
                const result = await child.invoke(value, config);
                return { ...result, round: value.round + 1 };
              })
              .addEdge(START, 'parent')
              .addConditionalEdges('parent', ({ round }) =>
                mode === 'task-scopes' && round < 2 ? 'parent' : END,
              )
              .compile({ checkpointer: host.langchain.checkpointer() });
          },
        },
      );
      await instance.prepare();
      return { instance, runtime };
    };
    let fixture = await create();
    await fixture.instance.start({});
    await expect.poll(() => fixture.instance.getSnapshot().run?.status).toBe('waiting_input');
    expect(writes).toHaveLength(mode === 'restore' ? 1 : 3);
    const firstReceipts = receipts.slice();
    const firstPending = fixture.instance.getSnapshot().run?.pending;
    if (mode === 'restore') {
      const sessionId = fixture.instance.sessionId;
      await fixture.runtime.dispose();
      if (saver instanceof IndexedDBSaver) {
        saver.close();
        saver = await open();
      }
      fixture = await create(sessionId);
      await fixture.instance.restore();
      expect(fixture.instance.getSnapshot().run?.pending).toEqual(firstPending);
    }
    const submit = async (): Promise<void> => {
      const run = fixture.instance.getSnapshot().run;
      if (run?.pending === undefined) throw new Error('Expected a pending child interaction.');
      expect(
        await fixture.instance.dispatch({
          instanceId: fixture.instance.instanceId,
          runId: run.runId,
          ...run.pending,
          action: 'submit',
          payload: 'continued',
        }),
      ).toMatchObject({ status: 'accepted' });
    };
    await submit();
    if (mode === 'task-scopes') {
      await expect.poll(() => fixture.instance.getSnapshot().run?.status).toBe('waiting_input');
      expect(fixture.instance.getSnapshot().run?.pending?.interactionId).not.toBe(
        firstPending?.interactionId,
      );
      expect(writes).toHaveLength(6);
      expect(receipts.slice(3, 6)).toEqual(firstReceipts);
      await submit();
    }
    await expect.poll(() => fixture.instance.getSnapshot().run?.status).toBe('succeeded');
    if (mode === 'restore') {
      expect(parentBodies).toBe(2);
      expect(writes).toHaveLength(1);
      expect(receipts).toEqual([firstReceipts[0], firstReceipts[0]]);
    } else {
      expect(parentBodies).toBe(4);
      expect(writes).toHaveLength(6);
      expect(new Set(writes.map(({ effectId }) => effectId)).size).toBe(6);
      expect(receipts).toHaveLength(12);
      expect(receipts.slice(9, 12)).toEqual(receipts.slice(6, 9));
    }
  },
);
