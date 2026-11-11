// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { PyodideAdapterOptions } from '../../../packages/adapter-pyodide/src/adapter.js';
import fixtures from '../cases-dspy/state-bind-fixtures.json' with { type: 'json' };
import type { StateRestoreScenario } from './dspy-state-restore.js';

export interface StateBindScenario {
  readonly name: string;
  readonly program: StateRestoreScenario['program'];
  readonly swap: StateRestoreScenario['swap'];
  readonly pause: 'bound' | 'legacy';
  readonly predicted: 'completes' | 'unrecoverable';
  readonly then?: 'original';
  readonly lanes: readonly string[];
}
export const stateBindScenarios = fixtures.scenarios as readonly StateBindScenario[];

/** Observe outgoing Worker requests even when pending() rejects before a run exists. */
export function observeStateBind(options: PyodideAdapterOptions): {
  options: PyodideAdapterOptions;
  traffic: { models: number; capabilities: number; replayed: number };
} {
  const traffic = { models: 0, capabilities: 0, replayed: 0 };
  return {
    traffic,
    options: {
      ...options,
      createWorker() {
        const worker = options.createWorker();
        worker.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data)) as {
            kind: string;
            op: string;
            payload?: [unknown, unknown, { kind?: string }];
          };
          if (message.kind === 'request' && message.op === 'model') traffic.models++;
          if (message.kind === 'request' && message.op === 'capability') traffic.capabilities++;
          if (message.op === 'stream' && message.payload?.[2]?.kind === 'replayed')
            traffic.replayed++;
        });
        return worker;
      },
    },
  };
}
