// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import fixtures from '../cases-dspy/parallel-fixtures.json' with { type: 'json' };

export const parallelScenarios: readonly string[] = fixtures.scenarios;
export type ParallelOrder = keyof typeof fixtures.orders;
export interface ParallelStep {
  readonly name: string;
  readonly order?: ParallelOrder;
  readonly sessionId?: string;
  readonly crashAfterTwoWrites?: boolean;
  readonly question?: string;
}
export const parallelLabels = ['alpha', 'beta', 'gamma'] as const;

export function parallelAnswers(shape: 'single' | 'multi' | 'write', stage = 'before'): unknown[] {
  return parallelLabels.map((label) => {
    const first = `${label}:${stage}`;
    if (shape === 'write') return `receipt:${first}`;
    return shape === 'single'
      ? first
      : { first, receipt: `receipt:${first}`, answer: `${label}:last-${stage}` };
  });
}

export function parallelReply(question: string): string {
  return `[[ ## answer ## ]]\n${question}\n[[ ## completed ## ]]`;
}
