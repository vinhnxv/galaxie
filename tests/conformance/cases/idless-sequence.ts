// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ConformanceCase, ConformanceGraph } from '../support/transcript.js';
import { createGraph } from './idless.js';
export const identity = 'idless';
export const input = { value: 1 };
export const script = {};
export const resumes: NonNullable<ConformanceCase['resumes']> = [
  { action: 'submit', payload: { answer: 'yes' } },
  { action: 'submit', payload: { answer: 'second' } },
];
export function factory(...args: Parameters<ConformanceCase['factory']>): ConformanceGraph {
  return createGraph(args, true);
}
