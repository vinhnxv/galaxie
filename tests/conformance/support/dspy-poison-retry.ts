// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  type PendingInteraction,
  type RecoveryStore,
  type RunId,
} from '@galaxie-ai/core';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import { observeStateBind } from './dspy-state-bind.js';

export interface PoisonRetryResult {
  readonly errors: unknown[];
  readonly snapshots: string[];
  readonly calls: string[];
  readonly requests: number;
}

export async function executePoisonRetry(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  store: {
    readonly checkpoints: { request(value: unknown): Promise<unknown> };
    readonly recovery: RecoveryStore;
  },
  snapshot: () => Promise<string>,
): Promise<PoisonRetryResult> {
  const calls: string[] = [];
  const errors: unknown[] = [];
  const snapshots: string[] = [];
  const observed = observeStateBind(options);
  const runtime = createRuntime({
    appId: 'dspy-restore',
    executors: [createPyodideAdapter({ ...observed.options, framework: 'dspy' })],
    budgets: { steps: 10, toolCalls: 10, tokens: 1000 },
    outputSafety: () => 'allow',
  });
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/dspy-poison-retry',
        version: '1',
        executor: 'dspy-python',
        input: z.object({ question: z.string() }),
        capabilities: {
          required: {
            'docs.lookup@1': {
              kind: 'read',
              input: z.object({ query: z.string() }),
              output: z.string(),
            },
          },
        },
      }),
      {
        principalScope: 'fixture',
        agent,
        recovery: store.recovery,
        services: { checkpoints: store.checkpoints, chatModels: {} },
        ui: {
          surfaces: ['main'],
          components: { 'test.Review/v1': { actions: { continue: { payload: z.string() } } } },
        },
        bindings: {
          'docs.lookup@1': {
            kind: 'read',
            destination: 'in-browser',
            timeoutMs: 10000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            async invoke(input: { query: string }) {
              calls.push(input.query);
              return 'found';
            },
          },
        },
      },
    );
    await instance.prepare();
    const first = await instance.start({ question: 'same-instance' });
    let pending: PendingInteraction | undefined;
    for await (const event of instance.events(first.runId)) {
      if (event.type === 'interaction') {
        pending = event.interaction;
        break;
      }
      if (event.type === 'error') throw new Error('The poison retry program did not pause.');
    }
    if (!pending) throw new Error('The poison retry interaction is missing.');
    const receipt = await instance.dispatch({
      instanceId: instance.instanceId,
      runId: first.runId,
      ...pending,
      action: 'continue',
      payload: 'continue',
    });
    if (receipt.status !== 'accepted') throw new Error('The poison retry answer was rejected.');
    const collect = async (runId: RunId): Promise<void> => {
      for await (const event of instance.events(runId)) {
        if (event.type === 'error') errors.push(event.error);
      }
      snapshots.push(await snapshot());
    };
    await collect(first.runId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = await instance.start({ question: 'same-instance' });
      await collect(retry.runId);
    }
    return { errors, snapshots, calls, requests: observed.traffic.models };
  } finally {
    await runtime.dispose();
  }
}
