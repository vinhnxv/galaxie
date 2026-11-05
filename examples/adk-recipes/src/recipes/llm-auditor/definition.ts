// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { PyodideAgent } from '@galaxie/adapter-pyodide';
import { type AgentDefinition, defineAgentDefinition } from '@galaxie/core';
import { z } from 'zod';
import { capabilityRequests } from '../../host/capabilities.js';

export const auditorDefinition: AgentDefinition = defineAgentDefinition({
  id: 'galaxie.adk-recipes.llm-auditor',
  version: '0.0.0',
  executor: 'adk-python',
  input: z.strictObject({ prompt: z.string().trim().min(1).max(4096) }),
  models: {
    'auditor.critic': {
      modality: 'text',
      languages: ['en'],
      requires: ['tool-calling'],
      defaultPolicy: 'local-only',
    },
    'auditor.reviser': { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' },
  },
  capabilities: { required: { 'market.search@1': capabilityRequests['market.search@1'] } },
});

/** baseUrl points to this example's same-origin python/agent/ asset directory. */
export function auditorAgent(baseUrl: string): PyodideAgent {
  return {
    baseUrl,
    module: 'llm_auditor.agent',
    entry: 'create_agent',
    files: ['llm_auditor/__init__.py', 'llm_auditor/agent.py', 'llm_auditor/prompts.py'],
  };
}
