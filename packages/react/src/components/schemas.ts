// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import type { ActionDefinition } from '../registry.js';

export const idSchema: z.ZodString = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const shortTextSchema: z.ZodString = z.string().max(200);
export const longTextSchema: z.ZodString = z.string().max(2000);

export function uniqueIds(items: readonly { readonly id: string }[]): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

export type ContinueActions = {
  readonly continue: ActionDefinition<Record<string, never>>;
};

export const continueActions: ContinueActions = {
  continue: { label: 'Continue', payload: z.strictObject({}) },
};
