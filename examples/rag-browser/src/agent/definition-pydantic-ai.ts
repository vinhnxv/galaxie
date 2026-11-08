// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { defineAgentDefinition } from '@galaxie-ai/core';
import { type RagDefinition, ragDefinition } from './definition.js';

export const pydanticAiRagDefinition: RagDefinition = defineAgentDefinition({
  ...ragDefinition,
  id: 'galaxie.rag-browser.pydantic-ai',
  executor: 'pydantic-ai-python',
});
