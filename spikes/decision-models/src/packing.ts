// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Question } from './questions.js';

export const REQUEST_CAP = 16;
export const SIMULATED_ROW_TOKENS = 4096;
/** Simulation only: ceil(UTF-16 code units / 4), not any candidate's tokenizer. */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
export function stateFixture(tokens: 200 | 1000): string {
  return 'ctx '.repeat(tokens);
}
export function rowTokens(state: string, questions: readonly Question[]): number {
  return approximateTokens(
    JSON.stringify({
      state,
      questions: questions.map(({ id, type, prompt, options }) => ({ id, type, prompt, options })),
    }),
  );
}
export function validateRequest(
  state: string,
  questions: readonly Question[],
  allowOversize = false,
): void {
  if (questions.length === 0 || (!allowOversize && questions.length > REQUEST_CAP))
    throw new Error('question_count');
  if (rowTokens(state, questions) > SIMULATED_ROW_TOKENS) throw new Error('row_too_long');
}
/** Explicit caller batching; providers reject requests above their cap and never batch. */
export function batches<T>(items: readonly T[]): T[][] {
  if (!items.length) throw new Error('question_count');
  return Array.from({ length: Math.ceil(items.length / REQUEST_CAP) }, (_, index) =>
    items.slice(index * REQUEST_CAP, (index + 1) * REQUEST_CAP),
  );
}
