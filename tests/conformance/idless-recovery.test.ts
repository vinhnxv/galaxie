// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter, requestInteraction } from '@galaxie-ai/adapter-langgraph';
import { createRuntime, type DiagnosticEvent, type SessionId } from '@galaxie-ai/core';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph/web';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { ask } from './cases/idless.js';

const runtimes: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});
const modes = ['sync', 'async', 'exit'] as const;
const windows = ['unaccepted', 'accepted', 'held', 'held-abort', 'unconsumed', 'complete'] as const;
const answer = { action: 'submit', payload: { answer: 'unique-private-idless-answer' } };

test.each(modes.flatMap((mode) => windows.map((window) => ({ mode, window }))))(
  '$mode recovers the $window window with one committed application',
  async ({ mode, window }) => {
    const saver = new MemorySaver();
    const store = new MemoryRecoveryStore();
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const counts = { body: 0 };
    const order: string[] = [];
    const identities: string[] = [];
    const registered: unknown[] = [];
    const diagnostics: DiagnosticEvent[] = [];
    let crash = true;
    const make = async (sessionId?: SessionId) => {
      const adapter = createLangGraphAdapter();
      const runtime = createRuntime({
        appId: 'idless-recovery',
        diagnostics: (event) => diagnostics.push(event),
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
                  const result = await executor.pending(
                    id,
                    options === undefined
                      ? undefined
                      : {
                          registerRestoredData(value) {
                            registered.push(value);
                            order.push('registered');
                            options.registerRestoredData?.(value);
                          },
                        },
                  );
                  if (result !== undefined) identities.push(result.interactionId);
                  return result;
                },
                run(request) {
                  return executor.run({
                    ...request,
                    registerRestoredData(value) {
                      registered.push(value);
                      order.push('registered');
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
          answer: Annotation<unknown>,
          applications: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
        }),
      )
        .addNode('gate', async (_, config) => {
          counts.body++;
          order.push('body');
          const submitted = await ask({ request: requestInteraction }, config);
          if (crash && (window === 'held' || window === 'held-abort')) {
            entered.resolve();
            await held.promise;
            if (window === 'held-abort' && config.signal?.aborted)
              throw new Error('The simulated page closed.');
          }
          return { answer: submitted, applications: 1 };
        })
        .addEdge(START, 'gate')
        .addEdge('gate', END)
        .compile({ checkpointer: saver })
        .withConfig({ durability: mode });
      const instance = await runtime.create(
        {
          id: 'tests/idless-recovery',
          version: '1.0.0',
          executor: 'langgraph-js',
          input: z.unknown(),
        },
        {
          principalScope: 'tests',
          recovery: store,
          ...(sessionId === undefined ? {} : { sessionId }),
          agent: () => graph,
        },
      );
      await instance.prepare();
      return { runtime, instance, graph };
    };
    const first = await make();
    const { runId } = await first.instance.start({});
    for await (const event of first.instance.events(runId)) if (event.type === 'interaction') break;
    const pending = first.instance.getSnapshot().run?.pending;
    if (pending === undefined) throw new Error('Expected an ID-less pause.');
    expect(pending.interactionId).toMatch(/^idless:[0-9a-f-]{36}:0$/);
    const submission = { instanceId: first.instance.instanceId, runId, ...pending, ...answer };
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
      for await (const _event of first.instance.events(runId)) {
        /* Wait for the terminal segment. */
      }
      await first.runtime.dispose();
    } else {
      await entered.promise;
      if (window === 'held' || window === 'held-abort') {
        const tuple = await saver.getTuple({
          configurable: { thread_id: first.instance.sessionId },
        });
        expect(
          tuple?.pendingWrites?.some(
            ([id, channel]) =>
              id === '00000000-0000-0000-0000-000000000000' && channel === '__resume__',
          ),
        ).toBe(mode !== 'exit');
      }
      const disposal = first.runtime.dispose();
      held.resolve();
      await receipt;
      await disposal;
    }
    intercept?.mockRestore();
    crash = false;
    order.length = 0;
    const restored = await make(first.instance.sessionId);
    const run = await restored.instance.restore();
    if (window === 'unaccepted') {
      expect(restored.instance.getSnapshot().run?.pending).toEqual(pending);
      const event = {
        ...submission,
        instanceId: restored.instance.instanceId,
        runId: run?.runId as typeof runId,
      };
      const accepted = restored.instance.dispatch(event);
      expect(await restored.instance.dispatch(event)).toMatchObject({
        status: 'rejected',
        error: { code: 'duplicate' },
      });
      expect(await accepted).toMatchObject({ status: 'accepted' });
    }
    if (run !== undefined) {
      for await (const _event of restored.instance.events(run.runId)) {
        /* Wait for replay settlement. */
      }
      expect(restored.instance.getSnapshot().run?.status).toBe('succeeded');
      expect(restored.instance.getSnapshot().run?.labels).toContain('private-user');
    } else expect(['unconsumed', 'complete']).toContain(window);
    await restored.runtime.dispose();
    expect(identities.every((id) => id === pending.interactionId)).toBe(true);
    expect(counts.body).toBe(window === 'held' || window === 'held-abort' ? 3 : 2);
    const state = await restored.graph.getState({
      configurable: { thread_id: restored.instance.sessionId },
    });
    expect(state.values).toEqual({ answer, applications: 1 });
    expect(state.next).toEqual([]);
    expect((await store.submissions(first.instance.sessionId))[0]?.status).toBe('consumed');
    if ((window === 'held' || window === 'held-abort') && mode !== 'exit') {
      expect(registered).toContainEqual(answer);
      expect(order.indexOf('registered')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('registered')).toBeLessThan(order.indexOf('body'));
    }
    expect(pending.interactionId).not.toContain(answer.payload.answer);
    expect(
      JSON.stringify({ error: restored.instance.getSnapshot().run?.error, diagnostics }),
    ).not.toContain(answer.payload.answer);
    expect(
      await store.acceptSubmission(first.instance.sessionId, {
        interactionId: pending.interactionId,
        ...answer,
      }),
    ).toBe('duplicate');
    const final = await make(first.instance.sessionId);
    expect(await final.instance.restore()).toBeUndefined();
  },
);
