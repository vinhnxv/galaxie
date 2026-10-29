// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter, requestInteraction } from '@galaxie/adapter-langgraph';
import { type CapabilityContext, createRuntime } from '@galaxie/core';
import { IndexedDBSaver } from '@galaxie/storage-indexeddb';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph/web';
import { expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';
import { collect } from '../../packages/core/test/fake-executor.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { assistantRoles, assistantRouting } from './support/routing.js';
import { ScriptedChatModel } from './support/scripted-chat-model.js';

test.each([true, false])(
  'AT-35: parent effects before a child interrupt repeat on resume (recovery=%s)',
  async (withRecovery) => {
    const databaseName = `galaxie-subgraph-effects-${crypto.randomUUID()}`;
    const saver =
      typeof indexedDB === 'undefined'
        ? undefined
        : await IndexedDBSaver.open({
            databaseName,
            appId: 'subgraph-effects',
            principalScope: 'test',
          });
    const recovery = saver?.recovery ?? new MemoryRecoveryStore();
    const writes: CapabilityContext[] = [];
    let parentBodies = 0;
    const runtime = createRuntime({
      appId: 'subgraph-effects',
      executors: [createLangGraphAdapter()],
    });
    onTestFinished(async () => {
      await runtime.dispose();
      saver?.close();
      if (saver !== undefined)
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(databaseName);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error('Subgraph database cleanup was blocked.'));
        });
    });
    const instance = await runtime.create(
      {
        id: 'conformance/subgraph-effects',
        version: '1.0.0',
        executor: 'langgraph-js',
        input: z.object({}),
        models: assistantRoles,
        capabilities: {
          required: {
            'save@1': {
              input: z.object({ value: z.literal('practice') }),
              output: z.object({ saved: z.boolean() }),
              kind: 'write',
            },
          },
        },
      },
      {
        principalScope: 'test',
        ...(withRecovery ? { recovery } : {}),
        services: {
          checkpointer: saver ?? new MemorySaver(),
          chatModels: { assistant: new ScriptedChatModel({}) },
        },
        models: assistantRouting(),
        bindings: {
          'save@1': {
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            kind: 'write',
            invoke: async (_input, context) => {
              writes.push(context);
              return { saved: true };
            },
          },
        },
        agent: (host) => {
          const state = Annotation.Root({ answer: Annotation<unknown> });
          const child = new StateGraph(state)
            .addNode('ask', async (_state, config) => {
              await Promise.resolve();
              return {
                answer: requestInteraction(
                  {
                    surfaceId: 'main',
                    viewRevision: 'r1',
                    component: 'conformance.Question/v1',
                    props: { question: 'Continue?' },
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
              await host.capabilities.call('save@1', { value: 'practice' }, config);
              return child.invoke(value, config);
            })
            .addEdge(START, 'parent')
            .addEdge('parent', END)
            .compile({ checkpointer: host.langchain.checkpointer() });
        },
      },
    );
    await instance.prepare();
    const { runId } = await instance.start({});
    await expect.poll(() => instance.getSnapshot().run?.status).toBe('waiting_input');
    expect(parentBodies).toBe(1);
    expect(writes).toHaveLength(1);
    const pending = instance.getSnapshot().run?.pending;
    if (pending === undefined) throw new Error('Expected the child interaction.');
    expect(
      await instance.dispatch({
        instanceId: instance.instanceId,
        runId,
        ...pending,
        action: 'submit',
        payload: { answer: 'continue' },
      }),
    ).toMatchObject({ status: 'accepted' });
    await expect.poll(() => instance.getSnapshot().run?.status).toBe('succeeded');
    expect((await collect(instance.events(runId))).at(-1)).toMatchObject({
      type: 'output',
      output: { answer: { answer: 'continue' } },
    });
    expect(parentBodies).toBe(2);
    // Characterization: resume starts a different journal segment. Recovery replays
    // receipts within a segment, but does not deduplicate these parent-node effects.
    expect(writes).toHaveLength(2);
    expect(writes[0]?.effectId).not.toBe(writes[1]?.effectId);
    if (withRecovery) {
      for (const write of writes)
        expect(await recovery.effect(instance.sessionId, write.effectId)).toMatchObject({
          status: 'succeeded',
          output: { saved: true },
        });
    }
  },
);
