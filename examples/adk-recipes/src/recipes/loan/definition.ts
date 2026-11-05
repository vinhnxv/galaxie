// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { PyodideAgent } from '@galaxie/adapter-pyodide';
import { type AgentDefinition, defineAgentDefinition, galaxieField } from '@galaxie/core';
import { z } from 'zod';
import { capabilityRequests } from '../../host/capabilities.js';

export const loanDefinition: AgentDefinition = defineAgentDefinition({
  id: 'galaxie.adk-recipes.loan',
  version: '0.0.0',
  executor: 'adk-python',
  ui: { catalog: 'recipes/v1', components: ['LoanApproval'], surfaces: ['main'] },
  input: z.strictObject({
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .meta(galaxieField({ label: 'private-user' })),
  }),
  models: Object.fromEntries(
    ['extraction', 'underwriting', 'pricing', 'decision'].map((role) => [
      `loan.${role}`,
      {
        modality: 'text' as const,
        languages: ['en'],
        requires: ['tool-calling'],
        defaultPolicy: 'local-only' as const,
      },
    ]),
  ),
  capabilities: {
    required: {
      'loan.documents@1': capabilityRequests['loan.documents@1'],
      'loan.business@1': capabilityRequests['loan.business@1'],
      'loan.price@1': capabilityRequests['loan.price@1'],
      'loan.finalize@1': capabilityRequests['loan.finalize@1'],
    },
  },
});

export function loanAgent(baseUrl: string): PyodideAgent {
  return {
    baseUrl,
    module: 'loan.agent',
    entry: 'create_agent',
    files: ['loan/__init__.py', 'loan/agent.py', 'loan/prompts.py'],
  };
}
