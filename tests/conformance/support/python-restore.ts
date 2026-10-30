// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createRuntime,
  defineAgentDefinition,
  type PendingInteraction,
  type RecoveryJson,
  type RecoveryStore,
  type SessionId,
} from '@galaxie/core';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';

export const pythonReloadCases = [
  'interrupt-resume',
  'interrupt-durability-sync',
  'interrupt-durability-exit',
  'interrupt-subgraph',
] as const;
export interface PythonRestoreResult {
  readonly sessionId: string;
  readonly pending?: PendingInteraction;
  readonly final?: unknown;
  readonly consumed?: boolean;
  readonly effects?: { readonly bodies: number; readonly writes: number };
}

/** Both lanes reconstruct the runtime and Worker; Chromium additionally reopens IndexedDB. */
export async function executePythonRestore(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  store: {
    readonly checkpoints: { request(value: unknown): Promise<unknown> };
    readonly recovery: RecoveryStore;
  },
  sessionId?: string,
  accepted = false,
  probeEffects = false,
  answer: RecoveryJson = { answer: 'yes' },
): Promise<PythonRestoreResult> {
  const effects = { bodies: 0, writes: 0 };
  const runtime = createRuntime({
    appId: 'python-restore',
    executors: [createPyodideAdapter(options)],
  });
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'conformance/python-restore',
      version: '1',
      executor: 'langgraph-python',
      input: z.unknown(),
      ...(probeEffects
        ? {
            capabilities: {
              required: {
                'body@1': {
                  kind: 'read' as const,
                  input: z.object({}),
                  output: z.object({ saved: z.boolean() }),
                },
                'save@1': {
                  kind: 'write' as const,
                  input: z.object({ value: z.number() }),
                  output: z.object({ saved: z.boolean() }),
                },
              },
            },
          }
        : {}),
    }),
    {
      principalScope: 'fixture',
      agent,
      recovery: store.recovery,
      services: { chatModels: {}, checkpoints: store.checkpoints },
      ...(probeEffects
        ? {
            bindings: {
              'body@1': {
                kind: 'read' as const,
                destination: 'in-browser' as const,
                timeoutMs: 1000,
                concurrency: 1,
                grantScope: 'instance' as const,
                approval: 'none' as const,
                retry: 'none' as const,
                invoke: async () => {
                  effects.bodies++;
                  return { saved: true };
                },
              },
              'save@1': {
                kind: 'write' as const,
                destination: 'in-browser' as const,
                timeoutMs: 1000,
                concurrency: 1,
                grantScope: 'instance' as const,
                approval: 'none' as const,
                retry: 'none' as const,
                invoke: async () => {
                  effects.writes++;
                  return { saved: true };
                },
              },
            },
          }
        : {}),
      ...(sessionId === undefined ? {} : { sessionId: sessionId as SessionId }),
    },
  );
  try {
    await instance.prepare();
    const run =
      sessionId === undefined ? await instance.start({ value: 1 }) : await instance.restore();
    if (!run) throw new Error('The Python run is missing.');
    let pending: PendingInteraction | undefined;
    if (sessionId === undefined) {
      for await (const event of instance.events(run.runId)) {
        if (event.type === 'error') throw new Error(event.error.message);
        if (event.type === 'interaction') {
          pending = instance.getSnapshot().run?.pending;
          break;
        }
      }
      if (!pending) throw new Error('The Python checkpoint has no pending interaction.');
      if (accepted)
        await store.recovery.acceptSubmission(instance.sessionId, {
          interactionId: pending.interactionId,
          action: 'submit',
          payload: answer,
        });
      return { sessionId: instance.sessionId, pending, ...(probeEffects ? { effects } : {}) };
    }
    pending = instance.getSnapshot().run?.pending;
    if (!accepted) {
      if (!pending) throw new Error('The restored Python checkpoint has no interaction.');
      const receipt = await instance.dispatch({
        instanceId: instance.instanceId,
        runId: run.runId,
        ...pending,
        action: 'submit',
        payload: answer,
      });
      if (receipt.status !== 'accepted') throw new Error('The Python answer was rejected.');
    }
    let final: unknown;
    for await (const event of instance.events(run.runId)) {
      if (event.type === 'error') throw new Error(event.error.message);
      if (event.type === 'output') final = event.output;
    }
    const submissions = await store.recovery.submissions(instance.sessionId);
    return {
      sessionId: instance.sessionId,
      ...(pending === undefined ? {} : { pending }),
      final,
      consumed: submissions.length === 1 && submissions[0]?.status === 'consumed',
      ...(probeEffects ? { effects } : {}),
    };
  } finally {
    await runtime.dispose();
  }
}
