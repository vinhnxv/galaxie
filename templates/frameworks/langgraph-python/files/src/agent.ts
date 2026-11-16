// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { pythonBuild } from 'virtual:galaxie-python';
import type { PyodideAgent } from '@galaxie-ai/adapter-pyodide';
import { type AgentDefinition, defineAgentDefinition } from '@galaxie-ai/core';
import { z } from 'zod';

const inputSchema: z.ZodType<Record<string, never>, Record<string, never>> = z.strictObject({});
interface TemplateDefinition extends AgentDefinition {
  readonly input: typeof inputSchema;
}
export const templateDefinition: TemplateDefinition = defineAgentDefinition({
  id: 'local-only.starter',
  version: '0.0.0',
  executor: 'langgraph-python',
  input: inputSchema,
  models: { comment: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  ui: { catalog: 'education/v1', components: ['Quiz'], surfaces: ['question'] },
});
export const commentPrompt = 'Give one short encouraging sentence about practicing.';

export function createTemplateAgent(): PyodideAgent {
  return {
    baseUrl: new URL(pythonBuild.agentUrl, location.href).href,
    files: pythonBuild.agentFiles,
    module: 'starter_agent.graph',
    entry: 'create_agent',
  };
}
