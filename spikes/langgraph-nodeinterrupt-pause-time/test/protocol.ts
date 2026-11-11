// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  type ExecutorEvent,
  GalaxieError,
  type InteractionId,
  type PendingInteraction,
  parseInteractionRequest,
  type RunRequest,
  type SessionId,
  toErrorInfo,
} from '@galaxie-ai/core';
import { Command, MemorySaver } from '@langchain/langgraph';
import { expect } from 'vitest';
import { z } from 'zod';
import { MemoryRecoveryStore } from '../../../packages/core/test/support/memory-recovery-store.js';
import { type Candidate, readCandidate } from '../src/candidates.js';
import { reopenSaver } from '../src/checkpoint-reader.js';
import { answer, createFixture, type Durability, type Shape } from '../src/graphs.js';
import { Observer } from '../src/observer.js';

const definition = defineAgentDefinition({
  id: 'spike/nodeinterrupt-protocol',
  version: '1.0.0',
  executor: 'nodeinterrupt-protocol',
  input: z.unknown(),
});

interface ProtocolOutcome {
  status: string | undefined;
  error: unknown;
  counts: { gate: number; effects: number };
  inbox: string[];
}

/** Narrow publication/inbox witness for native forgery and replacement probes, not a parity executor. */
export async function protocolProbe(
  shape: Shape,
  mode: Durability,
  candidate?: Candidate,
  thrown?: () => never,
): Promise<{ live: ProtocolOutcome & { published: number }; restored: ProtocolOutcome }> {
  const setup = async (saver: MemorySaver, store: MemoryRecoveryStore, sessionId?: SessionId) => {
    const fixture = createFixture(shape, saver, undefined, thrown);
    let observer = new Observer();
    const config = (id: string) => ({ configurable: { thread_id: id }, durability: mode });
    const pending = async (
      id: SessionId,
      options?: Pick<RunRequest, 'registerRestoredData'>,
    ): Promise<PendingInteraction | undefined> => {
      const state = await fixture.graph.getState(config(id));
      const interrupts = state.tasks.flatMap((task) => task.interrupts);
      if (interrupts.length === 0) return undefined;
      const pause = interrupts[0];
      if (candidate !== undefined)
        return readCandidate(
          candidate,
          state.tasks,
          id,
          saver,
          observer.errors,
          options?.registerRestoredData,
        );
      const request = parseInteractionRequest(pause?.value);
      if (request === undefined || typeof pause?.id !== 'string')
        throw new GalaxieError('unsupported', toErrorInfo('unsupported').message);
      return { interactionId: pause.id as InteractionId, ...request };
    };
    const adapter: ExecutorAdapter<unknown, unknown> = {
      id: definition.executor,
      version: '1.0.0',
      features: {
        interrupts: true,
        resume: true,
        checkpoints: true,
        streaming: true,
        subgraphs: false,
      },
      async prepare() {
        return {
          pending,
          async *run(request): AsyncGenerator<ExecutorEvent> {
            observer = new Observer();
            const command = request.command;
            const input =
              command.type === 'start'
                ? {}
                : new Command({
                    resume: command.interactionId.startsWith('idless:')
                      ? { action: command.action, payload: command.payload }
                      : {
                          [command.interactionId]: {
                            action: command.action,
                            payload: command.payload,
                          },
                        },
                  });
            try {
              let interrupted = false;
              let output: unknown;
              for await (const chunk of await fixture.graph.stream(input, {
                ...config(request.sessionId),
                streamMode: 'updates',
                callbacks: [observer],
                signal: request.signal,
              })) {
                if ('__interrupt__' in chunk) interrupted = true;
                else output = chunk;
              }
              if (interrupted) {
                const interaction = await pending(request.sessionId, request);
                if (
                  interaction === undefined ||
                  (command.type === 'resume' && interaction.interactionId === command.interactionId)
                )
                  yield { type: 'error', error: toErrorInfo('unsupported') };
                else yield { type: 'interaction', interaction };
              } else yield { type: 'output', output };
            } catch (error) {
              if (!(error instanceof GalaxieError) || error.code !== 'unsupported') throw error;
              yield { type: 'error', error: toErrorInfo('unsupported') };
            }
          },
          async dispose() {},
        };
      },
    };
    const runtime = createRuntime({ appId: 'nodeinterrupt-spike', executors: [adapter] });
    const instance = await runtime.create(definition, {
      principalScope: 'scripted',
      agent: {},
      recovery: store,
      ...(sessionId === undefined ? {} : { sessionId }),
      ui: {
        surfaces: ['main'],
        components: {
          'conformance.Question/v1': {
            actions: { submit: { payload: z.object({ answer: z.string() }) } },
          },
        },
      },
    });
    await instance.prepare();
    return { runtime, instance, ...fixture };
  };
  const store = new MemoryRecoveryStore();
  const saver = new MemorySaver();
  const live = await setup(saver, store);
  let restored: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    const { runId } = await live.instance.start({});
    let published = 0;
    for await (const event of live.instance.events(runId)) {
      if (event.type === 'interaction') {
        published++;
        break;
      }
    }
    const pausedSaver = reopenSaver(saver, true);
    const pausedStore = new MemoryRecoveryStore();
    for (const [key, value] of store.sessions)
      pausedStore.sessions.set(key, structuredClone(value));
    const waiting = live.instance.getSnapshot().run?.pending;
    if (waiting !== undefined) {
      expect(
        await live.instance.dispatch({
          instanceId: live.instance.instanceId,
          runId,
          ...waiting,
          ...answer,
        }),
      ).toMatchObject({ status: 'accepted' });
      for await (const _event of live.instance.events(runId)) {
        /* Drain settlement. */
      }
    }
    const liveResult = {
      published,
      status: live.instance.getSnapshot().run?.status,
      error: live.instance.getSnapshot().run?.error,
      counts: { ...live.counts },
      inbox: (await store.submissions(live.instance.sessionId)).map((entry) => entry.status),
    };
    await live.runtime.dispose();
    restored = await setup(
      candidate === undefined ? pausedSaver : reopenSaver(saver, true),
      candidate === undefined ? pausedStore : store,
      live.instance.sessionId,
    );
    let restoreError: unknown;
    try {
      const run = await restored.instance.restore();
      if (run !== undefined) {
        const pending = restored.instance.getSnapshot().run?.pending;
        if (candidate === undefined) expect(pending).toEqual(waiting);
        if (pending !== undefined)
          expect(
            await restored.instance.dispatch({
              instanceId: restored.instance.instanceId,
              runId: run.runId,
              ...pending,
              ...answer,
            }),
          ).toMatchObject({ status: 'accepted' });
        for await (const _event of restored.instance.events(run.runId)) {
          /* Drain settlement. */
        }
      }
    } catch (error) {
      // Core maps a pending() rejection to executor_error on restore.
      expect(error).toMatchObject(toErrorInfo('executor_error'));
      restoreError = toErrorInfo('executor_error');
    }
    const restoredResult = {
      status: restored.instance.getSnapshot().run?.status,
      error: restoreError ?? restored.instance.getSnapshot().run?.error,
      counts: restored.counts,
      inbox: (
        await (candidate === undefined ? pausedStore : store).submissions(live.instance.sessionId)
      ).map((entry) => entry.status),
    };
    return { live: liveResult, restored: restoredResult };
  } finally {
    await live.runtime.dispose();
    await restored?.runtime.dispose();
  }
}
