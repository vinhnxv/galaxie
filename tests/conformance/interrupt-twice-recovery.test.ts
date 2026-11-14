// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter, requestInteraction } from '@galaxie-ai/adapter-langgraph';
import {
  type AgentInstance,
  createRuntime,
  type ExecutorAgent,
  type InteractionId,
  type PendingInteraction,
  type RunId,
  type SessionId,
  toErrorInfo,
} from '@galaxie-ai/core';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph/web';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { questions } from './cases/interrupt-twice.js';

const runtimes: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

const modes = ['sync', 'async', 'exit'] as const;
const windows = ['unaccepted', 'accepted', 'held', 'held-abort', 'unconsumed', 'complete'] as const;
const answers = [
  { action: 'submit', payload: { answer: 'private-first-repeated-answer' } },
  { action: 'submit', payload: { answer: 'private-second-repeated-answer' } },
] as const;

async function settle(
  instance: AgentInstance<unknown, unknown>,
  runId: RunId,
): Promise<PendingInteraction | undefined> {
  for await (const event of instance.events(runId)) {
    if (event.type === 'error') throw new Error(`The recovery run failed: ${event.error.code}`);
    const pending = instance.getSnapshot().run?.pending;
    if (event.type === 'interaction' && pending?.interactionId === event.interaction.interactionId)
      return pending;
  }
  return undefined;
}

test.each(
  modes.flatMap((mode) =>
    windows.flatMap((window) => [0, 1].map((ordinal) => ({ mode, window, ordinal }))),
  ),
)(
  '$mode recovers the $window window around answer $ordinal without applying either answer twice',
  async ({ mode, window, ordinal }) => {
    let saver = new MemorySaver();
    const store = new MemoryRecoveryStore();
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const order: Array<
      { kind: 'registered'; value: unknown } | { kind: 'pending'; id: string } | { kind: 'body' }
    > = [];
    const identities: string[] = [];
    let bodyCount = 0;
    let crash = true;
    const make = async (sessionId?: SessionId) => {
      const adapter = createLangGraphAdapter();
      const runtime = createRuntime({
        appId: 'repeated-recovery',
        executors: [
          {
            ...adapter,
            async prepare(
              agent: Parameters<typeof adapter.prepare>[0],
              services: Parameters<typeof adapter.prepare>[1],
              options: Parameters<typeof adapter.prepare>[2],
            ) {
              const executor = await adapter.prepare(agent, services, options);
              return {
                ...executor,
                async pending(id, options) {
                  const pending = await executor.pending(
                    id,
                    options === undefined
                      ? undefined
                      : {
                          registerRestoredData(value) {
                            order.push({ kind: 'registered', value });
                            options.registerRestoredData?.(value);
                          },
                        },
                  );
                  if (pending !== undefined) {
                    identities.push(pending.interactionId);
                    order.push({ kind: 'pending', id: pending.interactionId });
                  }
                  return pending;
                },
                run(request) {
                  return executor.run({
                    ...request,
                    registerRestoredData(value) {
                      order.push({ kind: 'registered', value });
                      request.registerRestoredData?.(value);
                    },
                  });
                },
              };
            },
          },
        ],
      });
      runtimes.push(runtime);
      const graph = new StateGraph(
        Annotation.Root({
          answers: Annotation<unknown[]>,
          applications: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
        }),
      )
        .addNode('questions', async (_, config) => {
          bodyCount++;
          order.push({ kind: 'body' });
          const submitted: unknown[] = [];
          for (let index = 0; index < questions.length; index++) {
            submitted.push(requestInteraction(questions[index], config));
            if (crash && index === ordinal && (window === 'held' || window === 'held-abort')) {
              entered.resolve();
              await held.promise;
              if (window === 'held-abort') config.signal?.throwIfAborted();
            }
          }
          return { answers: submitted, applications: 1 };
        })
        .addEdge(START, 'questions')
        .addEdge('questions', END)
        .compile({ checkpointer: saver })
        .withConfig({ durability: mode });
      const instance = await runtime.create(
        {
          id: 'tests/repeated-recovery',
          version: '1.0.0',
          executor: 'langgraph-js',
          input: z.unknown(),
        },
        {
          principalScope: 'tests',
          recovery: store,
          agent: () => graph,
          ...(sessionId === undefined ? {} : { sessionId }),
        },
      );
      await instance.prepare();
      return { runtime, instance, graph };
    };
    const first = await make();
    const { runId } = await first.instance.start({});
    const initial = await settle(first.instance, runId);
    if (initial === undefined) throw new Error('Expected the first question.');
    const raw = initial.interactionId;
    expect(raw).not.toContain(':');
    await expect(
      first.instance.dispatch({
        instanceId: first.instance.instanceId,
        runId,
        ...initial,
        ...answers[0],
        interactionId: `${raw}:1` as InteractionId,
      }),
    ).resolves.toMatchObject({ status: 'rejected', error: { code: 'stale' } });
    if (ordinal === 1) {
      expect(
        await first.instance.dispatch({
          instanceId: first.instance.instanceId,
          runId,
          ...initial,
          ...answers[0],
        }),
      ).toMatchObject({ status: 'accepted' });
      expect(await settle(first.instance, runId)).toMatchObject({ interactionId: `${raw}:1` });
      expect(
        await first.instance.dispatch({
          instanceId: first.instance.instanceId,
          runId,
          ...initial,
          ...answers[0],
        }),
      ).toMatchObject({ status: 'rejected', error: { code: 'duplicate' } });
    }
    const pending = first.instance.getSnapshot().run?.pending;
    if (pending === undefined) throw new Error('Expected the target question.');
    expect(pending.interactionId).toBe(ordinal === 0 ? raw : `${raw}:1`);
    const targetAnswer = answers[ordinal];
    if (targetAnswer === undefined) throw new Error('Expected an answer for the target ordinal.');
    const submission = {
      instanceId: first.instance.instanceId,
      runId,
      ...pending,
      ...targetAnswer,
    };
    const accept = store.acceptSubmission.bind(store);
    const intercept =
      window === 'unaccepted' || window === 'accepted'
        ? vi.spyOn(store, 'acceptSubmission').mockImplementation(async (...args) => {
            const result = window === 'accepted' ? await accept(...args) : undefined;
            entered.resolve();
            await held.promise;
            if (result === undefined) throw new Error('The acceptance transaction was aborted.');
            return result;
          })
        : window === 'unconsumed'
          ? vi.spyOn(store, 'consumeSubmission').mockImplementation(async () => {
              entered.resolve();
              await held.promise;
              throw new Error('Consumption was interrupted.');
            })
          : undefined;
    const receipt = first.instance.dispatch(submission);
    if (window === 'complete') {
      expect(await receipt).toMatchObject({ status: 'accepted' });
      const next = await settle(first.instance, runId);
      expect(next?.interactionId).toBe(ordinal === 0 ? `${raw}:1` : undefined);
      await first.runtime.dispose();
    } else {
      await entered.promise;
      const disposal = first.runtime.dispose();
      held.resolve();
      await receipt;
      await disposal;
    }
    intercept?.mockRestore();
    crash = false;
    const reopened = new MemorySaver();
    reopened.storage = structuredClone(saver.storage);
    reopened.writes = structuredClone(saver.writes);
    const getTuple = reopened.getTuple.bind(reopened);
    vi.spyOn(reopened, 'getTuple').mockImplementation(async (config) => {
      const tuple = await getTuple(config);
      return tuple === undefined
        ? undefined
        : { ...tuple, pendingWrites: [...(tuple.pendingWrites ?? [])].reverse() };
    });
    saver = reopened;
    order.length = 0;
    const restored = await make(first.instance.sessionId);
    const run = await restored.instance.restore();
    if (window === 'unaccepted')
      expect(restored.instance.getSnapshot().run?.pending).toEqual(pending);
    if (run !== undefined) {
      let remaining = await settle(restored.instance, run.runId);
      while (remaining !== undefined) {
        const index = remaining.viewRevision === 'r1' ? 0 : 1;
        const event = {
          instanceId: restored.instance.instanceId,
          runId: run.runId,
          ...remaining,
          ...answers[index],
        };
        const accepted = restored.instance.dispatch(event);
        expect(await restored.instance.dispatch(event)).toMatchObject({
          status: 'rejected',
          error: { code: 'duplicate' },
        });
        expect(await accepted).toMatchObject({ status: 'accepted' });
        remaining = await settle(restored.instance, run.runId);
      }
      expect(restored.instance.getSnapshot().run?.status).toBe('succeeded');
      expect(restored.instance.getSnapshot().run?.labels).toContain('private-user');
    } else {
      expect(ordinal).toBe(1);
      expect(['unconsumed', 'complete']).toContain(window);
    }
    await restored.runtime.dispose();
    const state = await restored.graph.getState({
      configurable: { thread_id: restored.instance.sessionId },
    });
    expect(state.values).toEqual({ answers, applications: 1 });
    expect(state.next).toEqual([]);
    expect(bodyCount).toBe(window === 'held' || window === 'held-abort' ? 4 : 3);
    expect(identities.every((id) => id === raw || id === `${raw}:1`)).toBe(true);
    expect(await store.submissions(first.instance.sessionId)).toMatchObject([
      { interactionId: raw, ...answers[0], status: 'consumed' },
      { interactionId: `${raw}:1`, ...answers[1], status: 'consumed' },
    ]);
    if (ordinal === 1 || (ordinal === 0 && ['unconsumed', 'complete'].includes(window))) {
      const firstRegistration = order.findIndex(
        (entry) =>
          entry.kind === 'registered' &&
          JSON.stringify(entry.value).includes(answers[0].payload.answer),
      );
      const secondPublication = order.findIndex(
        (entry) => entry.kind === 'pending' && entry.id === `${raw}:1`,
      );
      if (secondPublication >= 0) {
        expect(firstRegistration).toBeGreaterThanOrEqual(0);
        expect(firstRegistration).toBeLessThan(secondPublication);
      }
      const body = order.findIndex((entry) => entry.kind === 'body');
      if (body >= 0 && mode !== 'exit') {
        expect(firstRegistration).toBeGreaterThanOrEqual(0);
        expect(firstRegistration).toBeLessThan(body);
      }
    }
    const final = await make(first.instance.sessionId);
    expect(await final.instance.restore()).toBeUndefined();
  },
);

test.each(modes)(
  '%s never publishes a phantom ordinal when the final checkpoint is interrupted',
  async (mode) => {
    const saver = new MemorySaver();
    const adapter = createLangGraphAdapter();
    let executor: ExecutorAgent | undefined;
    const runtime = createRuntime({
      appId: 'repeated-stale-checkpoint',
      executors: [
        {
          ...adapter,
          async prepare(
            agent: Parameters<typeof adapter.prepare>[0],
            services: Parameters<typeof adapter.prepare>[1],
            options: Parameters<typeof adapter.prepare>[2],
          ) {
            executor = await adapter.prepare(agent, services, options);
            return executor;
          },
        },
      ],
    });
    runtimes.push(runtime);
    const graph = new StateGraph(Annotation.Root({ answers: Annotation<unknown[]> }))
      .addNode('questions', (_, config) => ({
        answers: questions.map((question) => requestInteraction(question, config)),
      }))
      .addEdge(START, 'questions')
      .addEdge('questions', END)
      .compile({ checkpointer: saver })
      .withConfig({ durability: mode });
    const instance = await runtime.create(
      {
        id: 'tests/repeated-stale-checkpoint',
        version: '1.0.0',
        executor: 'langgraph-js',
        input: z.unknown(),
      },
      {
        principalScope: 'tests',
        recovery: new MemoryRecoveryStore(),
        agent: () => graph,
      },
    );
    await instance.prepare();
    const { runId } = await instance.start({});
    const initial = await settle(instance, runId);
    if (initial === undefined) throw new Error('Expected the first question.');
    expect(
      await instance.dispatch({
        instanceId: instance.instanceId,
        runId,
        ...initial,
        ...answers[0],
      }),
    ).toMatchObject({ status: 'accepted' });
    const second = await settle(instance, runId);
    if (second === undefined || executor === undefined)
      throw new Error('Expected the second question.');
    const checkpoint = await saver.getTuple({ configurable: { thread_id: instance.sessionId } });
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const intercept = vi.spyOn(saver, 'put').mockImplementation(async () => {
      entered.resolve();
      await held.promise;
      throw new Error('The final checkpoint was interrupted.');
    });
    expect(
      await instance.dispatch({ instanceId: instance.instanceId, runId, ...second, ...answers[1] }),
    ).toMatchObject({ status: 'accepted' });
    await entered.promise;
    try {
      const tuple = await saver.getTuple({ configurable: { thread_id: instance.sessionId } });
      expect(tuple?.checkpoint.id).toBe(checkpoint?.checkpoint.id);
      if (mode === 'exit') {
        expect(tuple?.pendingWrites?.some(([, channel]) => channel === 'answers')).toBe(false);
        expect(
          await executor.pending(instance.sessionId, { registerRestoredData: () => {} }),
        ).toEqual(second);
      } else {
        expect(tuple?.pendingWrites).toContainEqual([expect.any(String), 'answers', answers]);
        await expect(
          executor.pending(instance.sessionId, { registerRestoredData: () => {} }),
        ).rejects.toMatchObject(toErrorInfo('unsupported'));
      }
      expect(instance.getSnapshot().run?.pending).toBeUndefined();
    } finally {
      held.resolve();
    }
    const events = [];
    for await (const event of instance.events(runId)) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'executor_error' } });
    expect(
      events
        .filter((event) => event.type === 'interaction')
        .map((event) => event.interaction.interactionId),
    ).toEqual([initial.interactionId, second.interactionId]);
    intercept.mockRestore();
  },
);
