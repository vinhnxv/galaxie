// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { CASE_NAMES, type CaseName } from '../cases/index.js';
import matrix from '../compatibility-matrix.json' with { type: 'json' };

export interface CompatibilityEntry {
  readonly case: CaseName;
  readonly lane: 'native' | 'galaxie-node' | 'galaxie-chromium';
  readonly differences: string[];
  readonly reason: string;
}

const entrySchema: z.ZodType<CompatibilityEntry> = z.object({
  case: z.enum(CASE_NAMES),
  lane: z.enum(['native', 'galaxie-node', 'galaxie-chromium']),
  differences: z
    .array(z.string().startsWith('$'))
    .min(1)
    .refine((paths) => new Set(paths).size === paths.length),
  reason: z.string().trim().min(1),
});

export function parseCompatibilityMatrix(value: unknown): CompatibilityEntry[] {
  const entries = z.array(entrySchema).parse(value);
  const pairs = entries.map((entry) => `${entry.case}:${entry.lane}`);
  if (new Set(pairs).size !== pairs.length)
    throw new Error('Duplicate compatibility matrix entry.');
  return entries;
}

export const compatibilityMatrix: CompatibilityEntry[] = parseCompatibilityMatrix(matrix);
