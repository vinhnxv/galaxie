// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type AgentDefinition, defineAgentDefinition } from '@galaxie/core';
import { z } from 'zod';
import { capabilityRequests } from '../../host/capabilities.js';

export interface FinancialDefinition extends AgentDefinition {
  readonly input: z.ZodType<{ prompt: string }>;
  readonly capabilities: {
    readonly required: Pick<typeof capabilityRequests, 'market.search@1'>;
  };
}

export const financialDefinition: FinancialDefinition = defineAgentDefinition({
  id: 'galaxie.adk-recipes.financial-js',
  version: '0.0.0',
  executor: 'adk-js',
  input: z.strictObject({ prompt: z.string().trim().min(1).max(4096) }),
  models: {
    'financial.data': {
      modality: 'text',
      languages: ['en'],
      requires: ['tool-calling'],
      defaultPolicy: 'local-only',
    },
    'financial.trading': { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' },
    'financial.execution': { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' },
    'financial.risk': { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' },
  },
  capabilities: { required: { 'market.search@1': capabilityRequests['market.search@1'] } },
});
