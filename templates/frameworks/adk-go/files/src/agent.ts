// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { goBuild } from 'virtual:galaxie-go';
import type { GoAgent } from '@galaxie-ai/adapter-go';
import { type AgentDefinition, defineAgentDefinition } from '@galaxie-ai/core';
import { z } from 'zod';

const inputSchema: z.ZodType<{ prompt: string }, { prompt: string }> = z.strictObject({
  prompt: z.string().min(1),
});
interface TemplateDefinition extends AgentDefinition {
  readonly input: typeof inputSchema;
}
export const templateDefinition: TemplateDefinition = defineAgentDefinition({
  id: 'local-only.starter',
  version: '0.0.0',
  executor: 'adk-go',
  input: inputSchema,
  models: { comment: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  capabilities: {
    required: {
      'question.ask@1': {
        kind: 'read',
        input: z.strictObject({ message: z.string() }),
        output: z.strictObject({ pending: z.boolean() }),
      },
    },
  },
  ui: { catalog: 'education/v1', components: ['Quiz'], surfaces: ['question'] },
});
export const commentPrompt = 'Give one short encouraging sentence about practicing.';

export function createTemplateAgent(): GoAgent {
  return {
    entry: 'starter',
    stream: true,
    wasm: { ...goBuild.wasm, url: new URL(goBuild.wasm.url, location.href).href },
  };
}
