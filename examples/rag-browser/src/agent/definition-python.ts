// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { defineAgentDefinition } from '@galaxie/core';
import { type RagDefinition, ragDefinition } from './definition.js';

export const pythonRagDefinition: RagDefinition = defineAgentDefinition({
  ...ragDefinition,
  id: 'galaxie.rag-browser.python',
  executor: 'langgraph-python',
});
