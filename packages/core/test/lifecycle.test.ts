// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
  EFFECT_TRANSITIONS,
  INSTANCE_TRANSITIONS,
  RUN_TRANSITIONS,
  type Transitions,
} from '../src/index.js';

const TABLES: ReadonlyArray<readonly [string, Transitions<string>]> = [
  ['instance', INSTANCE_TRANSITIONS],
  ['run', RUN_TRANSITIONS],
  ['effect', EFFECT_TRANSITIONS],
];

function terminalStates(table: Transitions<string>): Set<string> {
  return new Set(Object.keys(table).filter((state) => table[state]?.length === 0));
}

function reachableFrom(table: Transitions<string>, start: string): Set<string> {
  const reached = new Set([start]);
  // A Set iterator also visits the entries added while it runs.
  for (const state of reached) {
    for (const next of table[state] ?? []) {
      reached.add(next);
    }
  }
  return reached;
}

test.each(TABLES)('every %s state can reach a terminal state', (_name, table) => {
  const terminal = terminalStates(table);
  for (const state of Object.keys(table)) {
    expect([...reachableFrom(table, state)].some((reached) => terminal.has(reached))).toBe(true);
  }
});

describe('instance transitions', () => {
  test('dispose can start from every state before disposing', () => {
    for (const state of ['created', 'preparing', 'ready'] as const) {
      expect(INSTANCE_TRANSITIONS[state]).toContain('disposing');
    }
  });
});

describe('run transitions', () => {
  test('a run ends as succeeded, failed or cancelled', () => {
    expect(terminalStates(RUN_TRANSITIONS)).toEqual(new Set(['succeeded', 'failed', 'cancelled']));
  });

  test('a run can be cancelled from every state that is not terminal', () => {
    for (const next of Object.values(RUN_TRANSITIONS)) {
      if (next.length > 0) {
        expect(next).toContain('cancelled');
      }
    }
  });
});

describe('effect transitions', () => {
  test('no transition leads back to planned, so an effect keeps its ID', () => {
    for (const next of Object.values(EFFECT_TRANSITIONS)) {
      expect(next).not.toContain('planned');
    }
  });
});
