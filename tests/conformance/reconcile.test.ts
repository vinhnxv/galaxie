// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter, requestInteraction } from '@galaxie-ai/adapter-langgraph';
import {
  type CapabilityContext,
  createRuntime,
  type ReconcileResult,
  type RecoveryStore,
  type SessionId,
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
import { expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { assistantRoles, assistantRouting } from './support/routing.js';
import { ScriptedChatModel } from './support/scripted-chat-model.js';
import type { ConformanceGraph } from './support/transcript.js';

async function fixture(missing: 'not-applied' | 'unknown' | 'throws') {
  const databaseName = `galaxie-reconcile-${crypto.randomUUID()}`;
  const savers: IndexedDBSaver[] = [];
  const runtimes: ReturnType<typeof createRuntime>[] = [];
  const backend = new Map<string, { saved: string }>();
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const open = async (): Promise<IndexedDBSaver> => {
    const saver = await IndexedDBSaver.open({
      databaseName,
      appId: 'reconcile-conformance',
      principalScope: 'conformance',
    });
    savers.push(saver);
    return saver;
  };
  onTestFinished(async () => {
    const disposal = Promise.all(runtimes.map((runtime) => runtime.dispose()));
    held.resolve();
    await disposal;
    for (const saver of savers) saver.close();
    if (savers.length > 0)
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Reconcile database cleanup was blocked.'));
      });
  });
  let saver: BaseCheckpointSaver =
    typeof indexedDB === 'undefined' ? new MemorySaver() : await open();
  const memoryRecovery = new MemoryRecoveryStore();
  const recovery = (): RecoveryStore =>
    saver instanceof IndexedDBSaver ? saver.recovery : memoryRecovery;
  const create = async (sessionId?: SessionId) => {
    const writes: CapabilityContext[] = [];
    const runtime = createRuntime({
      appId: 'reconcile-conformance',
      executors: [createLangGraphAdapter()],
    });
    runtimes.push(runtime);
    let graph: ConformanceGraph | undefined;
    const instance = await runtime.create(
      {
        id: 'conformance/reconcile',
        version: '1.0.0',
        executor: 'langgraph-js',
        input: z.object({}),
        models: assistantRoles,
        capabilities: {
          required: {
            'save@1': {
              input: z.string(),
              output: z.object({ saved: z.string() }),
              kind: 'write',
            },
          },
        },
      },
      {
        principalScope: 'conformance',
        ...(sessionId === undefined ? {} : { sessionId }),
        recovery: recovery(),
        services: { checkpointer: saver, chatModels: { assistant: new ScriptedChatModel({}) } },
        models: assistantRouting(),
        bindings: {
          'save@1': {
            kind: 'write',
            destination: 'in-browser',
            timeoutMs: 10000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            invoke: async (_input, context) => {
              writes.push(context);
              if (sessionId === undefined) {
                entered.resolve();
                await held.promise;
                if (context.signal.aborted)
                  throw new Error('The earlier write outcome is unknown.');
              }
              const output = { saved: 'invoked' };
              backend.set(context.effectId, output);
              return output;
            },
            reconcile: async (effectId): Promise<ReconcileResult<{ saved: string }>> => {
              if (missing === 'throws') throw new Error('The backend lookup failed.');
              const output = backend.get(effectId);
              return output === undefined ? { outcome: missing } : { outcome: 'applied', output };
            },
          },
        },
        agent: (host) => {
          const state = Annotation.Root({
            answer: Annotation<unknown>,
            receipt: Annotation<unknown>,
          });
          graph = new StateGraph(state)
            .addNode('save', async (_value, config) => {
              const answer = requestInteraction(
                {
                  surfaceId: 'main',
                  viewRevision: 'r1',
                  component: 'conformance.Question/v1',
                  props: {},
                },
                config,
              );
              const receipt = await host.capabilities.call('save@1', 'first', config);
              return { answer: answer.payload, receipt };
            })
            .addEdge(START, 'save')
            .addEdge('save', END)
            .compile({ checkpointer: host.langchain.checkpointer() })
            .withConfig({ durability: 'sync' });
          return graph;
        },
      },
    );
    await instance.prepare();
    if (graph === undefined) throw new Error('The reconciliation graph was not prepared.');
    return { runtime, instance, graph, writes };
  };
  const first = await create();
  await first.instance.start({});
  await expect.poll(() => first.instance.getSnapshot().run?.status).toBe('waiting_input');
  const run = first.instance.getSnapshot().run;
  if (run?.pending === undefined) throw new Error('Expected a pending write interaction.');
  expect(
    await first.instance.dispatch({
      instanceId: first.instance.instanceId,
      runId: run.runId,
      ...run.pending,
      action: 'submit',
      payload: 'continued',
    }),
  ).toMatchObject({ status: 'accepted' });
  await entered.promise;
  expect(first.writes).toHaveLength(1);
  const effectId = first.writes[0]?.effectId;
  if (effectId === undefined) throw new Error('The write effect ID is missing.');
  const sessionId = first.instance.sessionId;
  const receipt = () => recovery().effect(sessionId, effectId);
  expect(await receipt()).toMatchObject({ status: 'dispatched' });
  let current = first;
  const reload = async () => {
    const disposal = current.runtime.dispose();
    held.resolve();
    await disposal;
    if (saver instanceof IndexedDBSaver) {
      saver.close();
      saver = await open();
    }
    current = await create(sessionId);
    await current.instance.restore();
    return current;
  };
  return { backend, effectId, sessionId, receipt, reload };
}

test('replays an applied write after reload without invoking it again', async () => {
  const lane = await fixture('unknown');
  const output = { saved: 'already applied' };
  lane.backend.set(lane.effectId, output);
  const restored = await lane.reload();
  await expect.poll(() => restored.instance.getSnapshot().run?.status).toBe('succeeded');
  expect(restored.writes).toHaveLength(0);
  await restored.runtime.dispose();
  const state = await restored.graph.getState({ configurable: { thread_id: lane.sessionId } });
  expect(state.values).toMatchObject({ answer: 'continued', receipt: output });
  expect(await lane.receipt()).toMatchObject({ status: 'succeeded', output });
});

test('invokes a write once under its original effect ID when it was not applied', async () => {
  const lane = await fixture('not-applied');
  const restored = await lane.reload();
  await expect.poll(() => restored.instance.getSnapshot().run?.status).toBe('succeeded');
  expect(restored.writes).toHaveLength(1);
  expect(restored.writes[0]?.effectId).toBe(lane.effectId);
  await restored.runtime.dispose();
  const output = { saved: 'invoked' };
  const state = await restored.graph.getState({ configurable: { thread_id: lane.sessionId } });
  expect(state.values).toMatchObject({ answer: 'continued', receipt: output });
  expect(await lane.receipt()).toMatchObject({ status: 'succeeded', output });
});

test('keeps an unknown write blocked until a later reload finds its result', async () => {
  const lane = await fixture('unknown');
  const unresolved = await lane.reload();
  await expect.poll(() => unresolved.instance.getSnapshot().run?.status).toBe('failed');
  expect(unresolved.instance.getSnapshot().run?.error?.code).toBe('outcome_unknown');
  expect(unresolved.writes).toHaveLength(0);
  expect(await lane.receipt()).toMatchObject({ status: 'outcome_unknown' });

  const output = { saved: 'settled later' };
  lane.backend.set(lane.effectId, output);
  const settled = await lane.reload();
  await expect.poll(() => settled.instance.getSnapshot().run?.status).toBe('succeeded');
  expect(settled.writes).toHaveLength(0);
  await settled.runtime.dispose();
  const state = await settled.graph.getState({ configurable: { thread_id: lane.sessionId } });
  expect(state.values).toMatchObject({ answer: 'continued', receipt: output });
  expect(await lane.receipt()).toMatchObject({ status: 'succeeded', output });
});

test('keeps a write outcome unknown when reconciliation throws after reload', async () => {
  const lane = await fixture('throws');
  const restored = await lane.reload();
  await expect.poll(() => restored.instance.getSnapshot().run?.status).toBe('failed');
  expect(restored.instance.getSnapshot().run?.error?.code).toBe('outcome_unknown');
  expect(restored.writes).toHaveLength(0);
  expect(await lane.receipt()).toMatchObject({ status: 'outcome_unknown' });
});
