// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type AgentDefinition,
  type CapabilityRequest,
  defineAgentDefinition,
} from '@galaxie-ai/core';
import { RagInputSchema, SearchInputSchema, SearchResultSchema } from './schemas.js';

export interface RagDefinition extends AgentDefinition {
  readonly input: typeof RagInputSchema;
  readonly capabilities: {
    readonly required: {
      readonly 'docs.search@1': CapabilityRequest<
        typeof SearchInputSchema,
        typeof SearchResultSchema
      >;
    };
  };
}
export const ragDefinition: RagDefinition = defineAgentDefinition({
  id: 'galaxie.rag-browser',
  version: '0.0.0',
  executor: 'langgraph-js',
  input: RagInputSchema,
  capabilities: {
    required: {
      'docs.search@1': { kind: 'read', input: SearchInputSchema, output: SearchResultSchema },
    },
  },
  models: { 'rag.answer': { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  ui: { catalog: 'rag/v1', components: ['ReviewPassages'], surfaces: ['rag-review'] },
});
