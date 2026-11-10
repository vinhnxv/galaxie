// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import fixtures from '../cases-dspy/state-durable-fixtures.json' with { type: 'json' };

export const stateRestorePrograms = [
  'state-durable-early-model',
  'state-durable-late-model',
  'state-durable-fingerprint',
] as const;

export interface StateRestoreScenario {
  readonly name: string;
  readonly program: (typeof stateRestorePrograms)[number];
  readonly swap: keyof typeof fixtures.swaps;
  readonly outcome: 'completes' | 'unrecoverable';
}

export const stateRestoreScenarios = fixtures.scenarios as readonly StateRestoreScenario[];
