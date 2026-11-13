// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { LlmAgent } from '@google/adk';
import { z } from 'zod';
import type { AdkAgent } from '../../src/index.js';

export const toolsetAgent: AdkAgent = (host) => {
  const specs = [{ capability: 'math.double@1', toolName: 'double', description: 'Double.' }];
  const tools = specs.map((spec) =>
    host.adk.capabilityTool(spec.capability, {
      toolName: spec.toolName,
      description: spec.description,
      parameters: z.object({ value: z.number() }),
    }),
  );
  return new LlmAgent({ name: 'root', model: host.adk.llm('answer'), tools });
};
