// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import '../../src/host/adk-env.js';

import { pythonBuild } from 'virtual:adk-recipes-python';
import { IndexedDBSaver } from '../../../../packages/storage-indexeddb/src/index.js';
import { createPyodideWorker } from '../../src/host/trusted-types.js';
import { loanAgent } from '../../src/recipes/loan/definition.js';
import {
  answerLoan,
  type LoanHost,
  openLoan,
  type RecipeObservation,
  startLoan,
} from './python.js';

export interface LoanBrowserResult {
  readonly sessionId: string;
  readonly observation: RecipeObservation;
  readonly calls: readonly string[];
  readonly decisions: number;
  readonly outcome: ReturnType<LoanHost['outcome']>;
}

let host: LoanHost | undefined;
let saver: IndexedDBSaver | undefined;
let current: Awaited<ReturnType<typeof startLoan>> | undefined;

function result(): LoanBrowserResult {
  if (!host || !current) throw new Error('The loan probe has not started.');
  return {
    sessionId: host.instance.sessionId,
    observation: current.observation,
    calls: [...host.calls],
    decisions: host.capabilities.decisions().length,
    outcome: host.outcome(current.observation.pending),
  };
}

Object.assign(globalThis, {
  loanProbe: {
    async start(): Promise<LoanBrowserResult> {
      if (!pythonBuild.available) throw new Error('The verified Python assets are missing.');
      saver = await IndexedDBSaver.open({
        databaseName: 'adk-recipes-loan-test',
        appId: 'adk-recipes-loan',
        principalScope: 'demo',
      });
      const sessionId = sessionStorage.getItem('loan-session') ?? undefined;
      host = await openLoan(
        {
          framework: 'adk',
          runtimeUrl: new URL('/python/runtime/', location.href).href,
          wheelsUrl: new URL('/python/wheels/', location.href).href,
          localWheels: pythonBuild.localWheels,
          createWorker: createPyodideWorker,
        },
        loanAgent(new URL('/python/agent/', location.href).href),
        {
          checkpoints: saver.byteRecords,
          recovery: saver.recovery,
        },
        { ...(sessionId ? { sessionId } : {}) },
      );
      current = await startLoan(host, sessionId !== undefined);
      sessionStorage.setItem('loan-session', host.instance.sessionId);
      return result();
    },
    async answer(action: 'approve' | 'deny'): Promise<LoanBrowserResult> {
      if (!host || !current?.observation.pending) throw new Error('The loan pause is missing.');
      current = {
        runId: current.runId,
        observation: await answerLoan(host, current.runId, current.observation.pending, action),
      };
      return result();
    },
    async close(): Promise<void> {
      await host?.runtime.dispose();
      saver?.close();
    },
  },
});
