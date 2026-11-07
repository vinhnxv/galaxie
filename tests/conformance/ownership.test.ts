// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter, requestInteraction } from '@galaxie/adapter-langgraph';
import {
  type AgentInstance,
  type CapabilityBinding,
  type CapabilityContext,
  createRuntime,
  type SessionId,
  type UserInteractionEvent,
} from '@galaxie/core';
import { acquireOwnership, type Ownership } from '@galaxie/core/browser';
import { IndexedDBSaver } from '@galaxie/storage-indexeddb';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { assistantRoles, assistantRouting } from './support/routing.js';
import { ScriptedChatModel } from './support/scripted-chat-model.js';

const runtimes: Array<{ dispose(): Promise<void> }> = [];
const ownerships: Ownership[] = [];
const savers: IndexedDBSaver[] = [];
const databases: string[] = [];
const releases: Array<() => void> = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(ownerships.splice(0).map((owner) => owner.release()));
  for (const saver of savers.splice(0)) saver.close();
  for (const name of databases.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Ownership database cleanup was blocked.'));
    });
  }
  vi.restoreAllMocks();
});

async function open(appId: string): Promise<IndexedDBSaver> {
  const databaseName = `galaxie-ownership-${appId}`;
  if (!databases.includes(databaseName)) databases.push(databaseName);
  const saver = await IndexedDBSaver.open({ databaseName, appId, principalScope: 'learner' });
  savers.push(saver);
  return saver;
}
async function own(
  appId: string,
  saver: IndexedDBSaver,
  onHandoverRequest: () => Promise<void> | void,
  takeover = false,
  handoverTimeoutMs = 1000,
): Promise<Ownership> {
  const result = await acquireOwnership({
    appId,
    fence: saver.fencing,
    onHandoverRequest,
    takeover,
    handoverTimeoutMs,
  });
  if (result.status !== 'owner') throw new Error('The expected owner was busy.');
  ownerships.push(result.ownership);
  return result.ownership;
}
async function fixture(
  appId: string,
  saver: IndexedDBSaver,
  retry: CapabilityBinding['retry'],
  invoke: (input: string, context: CapabilityContext) => Promise<{ saved: string }>,
  sessionId?: SessionId,
) {
  const calls: CapabilityContext[] = [];
  const runtime = createRuntime({ appId, executors: [createLangGraphAdapter()] });
  runtimes.push(runtime);
  const instance = await runtime.create(
    {
      id: 'conformance/ownership',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({}),
      models: assistantRoles,
      capabilities: {
        required: {
          'save@1': { input: z.string(), output: z.object({ saved: z.string() }), kind: 'write' },
        },
      },
    },
    {
      principalScope: 'learner',
      recovery: saver.recovery,
      ...(sessionId === undefined ? {} : { sessionId }),
      models: assistantRouting(),
      services: { checkpointer: saver, chatModels: { assistant: new ScriptedChatModel({}) } },
      bindings: {
        'save@1': {
          kind: 'write',
          retry,
          destination: 'in-browser',
          timeoutMs: 15000,
          concurrency: 1,
          grantScope: 'instance',
          approval: 'none',
          invoke: async (input, context) => {
            calls.push(context);
            return invoke(input, context);
          },
        },
      },
      agent: (host) =>
        new StateGraph(Annotation.Root({ answer: Annotation<unknown>, saved: Annotation<string> }))
          .addNode('ask', async (_state, config) => {
            const answer = requestInteraction(
              {
                surfaceId: 'main',
                viewRevision: 'r1',
                component: 'conformance.Question/v1',
                props: { question: 'Continue?' },
              },
              config,
            );
            const receipt = await host.capabilities.call('save@1', 'first', config);
            return { answer: answer.payload, saved: (receipt as { saved: string }).saved };
          })
          .addEdge(START, 'ask')
          .addEdge('ask', END)
          .compile({ checkpointer: host.langchain.checkpointer() })
          .withConfig({ durability: 'sync' }),
    },
  );
  await instance.prepare();
  return { runtime, instance, calls };
}
async function pause(instance: AgentInstance<unknown, unknown>): Promise<UserInteractionEvent> {
  const { runId } = await instance.start({});
  await vi.waitFor(() => expect(instance.getSnapshot().run?.status).toBe('waiting_input'));
  const pending = instance.getSnapshot().run?.pending;
  if (pending === undefined) throw new Error('The ownership graph did not pause.');
  return {
    instanceId: instance.instanceId,
    runId,
    ...pending,
    action: 'submit',
    payload: { answer: 'private learner answer' },
  };
}

describe.skipIf(typeof indexedDB === 'undefined')('AT-18 app ownership', () => {
  test('a forced takeover refuses every former-owner result and preserves an unknown remote outcome', async () => {
    const appId = crypto.randomUUID();
    const a = await open(appId);
    const b = await open(appId);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    releases.push(() => finish.resolve());
    const first = await fixture(appId, a, 'none', async () => {
      entered.resolve();
      await finish.promise;
      return { saved: 'late private reply' };
    });
    const ownerA = await own(appId, a, () => new Promise(() => {}));
    const submitted = await pause(first.instance);
    expect(await first.instance.dispatch(submitted)).toMatchObject({ status: 'accepted' });
    await entered.promise;
    const effectId = first.calls[0]?.effectId;
    if (effectId === undefined) throw new Error('The effect ID is missing.');
    expect(await b.recovery.effect(first.instance.sessionId, effectId)).toMatchObject({
      status: 'dispatched',
    });
    const checkpointFailures: unknown[] = [];
    const put = a.put.bind(a);
    const putWrites = a.putWrites.bind(a);
    vi.spyOn(a, 'put').mockImplementation(async (...args) => {
      try {
        return await put(...args);
      } catch (error) {
        checkpointFailures.push(error);
        throw error;
      }
    });
    vi.spyOn(a, 'putWrites').mockImplementation(async (...args) => {
      try {
        await putWrites(...args);
      } catch (error) {
        checkpointFailures.push(error);
        throw error;
      }
    });
    const ownerB = await own(appId, b, () => {}, true, 25);
    await vi.waitFor(() => expect(ownerA.lostReason).toBe('stolen'));
    expect(await ownerB.verify()).toBe(true);
    const restored = await fixture(
      appId,
      b,
      'none',
      async () => ({ saved: 'must not invoke' }),
      first.instance.sessionId,
    );
    const resumed = await restored.instance.restore();
    expect(resumed).toBeDefined();
    await vi.waitFor(() =>
      expect(restored.instance.getSnapshot().run?.error?.code).toBe('outcome_unknown'),
    );
    expect(restored.calls).toHaveLength(0);
    const unknown = await b.recovery.effect(first.instance.sessionId, effectId);
    expect(unknown?.status).toBe('outcome_unknown');
    const config = { configurable: { thread_id: first.instance.sessionId } };
    const checkpoint = await b.getTuple(config);
    await expect(
      a.recovery.acceptSubmission(first.instance.sessionId, {
        interactionId: submitted.interactionId,
        action: 'submit',
        payload: 'late',
      }),
    ).rejects.toMatchObject({ code: 'fenced' });
    await expect(
      a.recovery.consumeSubmission(first.instance.sessionId, submitted.interactionId),
    ).rejects.toMatchObject({ code: 'fenced' });
    finish.resolve();
    await vi.waitFor(() => expect(first.instance.getSnapshot().run?.error?.code).toBe('fenced'));
    await vi.waitFor(() => expect(checkpointFailures.length).toBeGreaterThan(0));
    for (const error of checkpointFailures) expect(error).toMatchObject({ code: 'fenced' });
    expect(first.calls).toHaveLength(1);
    expect(await b.recovery.effect(first.instance.sessionId, effectId)).toEqual(unknown);
    expect(await b.getTuple(config)).toEqual(checkpoint);
    expect(JSON.stringify(first.instance.getSnapshot().run?.error)).not.toContain('private');
  }, 20000);

  test('a cooperative handover reuses the effect ID and commits one remote effect', async () => {
    const appId = crypto.randomUUID();
    const a = await open(appId);
    const b = await open(appId);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    releases.push(() => finish.resolve());
    const remote = new Map<string, { saved: string }>();
    const save = async (input: string, context: CapabilityContext): Promise<{ saved: string }> => {
      let receipt = remote.get(context.effectId);
      if (receipt === undefined) {
        receipt = { saved: input };
        remote.set(context.effectId, receipt);
      }
      return receipt;
    };
    const first = await fixture(appId, a, 'idempotency-key', async (input, context) => {
      const receipt = await save(input, context);
      entered.resolve();
      await finish.promise;
      return receipt;
    });
    const ownerA = await own(appId, a, async () => {
      const disposal = first.runtime.dispose();
      finish.resolve();
      await disposal;
    });
    expect(await first.instance.dispatch(await pause(first.instance))).toMatchObject({
      status: 'accepted',
    });
    await entered.promise;
    await own(appId, b, () => {}, true, 10000);
    expect(ownerA.lostReason).toBe('handover');
    const restored = await fixture(appId, b, 'idempotency-key', save, first.instance.sessionId);
    await restored.instance.restore();
    await vi.waitFor(() => expect(restored.instance.getSnapshot().run?.status).toBe('succeeded'));
    expect(first.calls).toHaveLength(1);
    expect(restored.calls).toHaveLength(1);
    expect(restored.calls[0]?.effectId).toBe(first.calls[0]?.effectId);
    expect(remote.size).toBe(1);
    const effectId = first.calls[0]?.effectId;
    if (effectId === undefined) throw new Error('The effect ID is missing.');
    expect(await b.recovery.effect(first.instance.sessionId, effectId)).toMatchObject({
      status: 'succeeded',
      output: { saved: 'first' },
    });
  }, 20000);

  test('a persisted pageshow notices an app epoch claimed by another connection', async () => {
    const appId = crypto.randomUUID();
    const a = await open(appId);
    const b = await open(appId);
    const ownerA = await own(appId, a, () => {});
    await b.fencing.claim();
    globalThis.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await vi.waitFor(() => expect(ownerA.lostReason).toBe('stale'));
    expect(ownerA.signal.reason).toBe('stale');
    expect(await ownerA.verify()).toBe(false);
  });
});
