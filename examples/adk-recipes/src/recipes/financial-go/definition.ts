// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { GoAgent } from '@galaxie-ai/adapter-go';
import { defineAgentDefinition } from '@galaxie-ai/core';
import { type FinancialDefinition, financialDefinition } from '../financial/definition.js';

export const financialGoDefinition: FinancialDefinition = defineAgentDefinition({
  ...financialDefinition,
  id: 'galaxie.adk-recipes.financial-go',
  executor: 'adk-go',
});

/** The host supplies same-origin wasm bytes and their verified build metadata. */
export function financialGoAgent(wasm: GoAgent['wasm']): GoAgent {
  return { wasm, entry: 'financial', stream: true };
}
