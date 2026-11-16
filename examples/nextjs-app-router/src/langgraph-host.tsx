// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createRuntime } from '@galaxie-ai/core';
import { createRegistry, Quiz } from '@galaxie-ai/react';
import type { ReactElement } from 'react';
import { AgentHost, type Host, mockDescriptor } from './host.js';
import {
  createExecutor,
  createMockModel,
  createServices,
  createTemplateAgent,
  readResult,
  type StarterInput,
  starterBindings,
  starterInput,
  templateDefinition,
} from './langgraph-js/executor.js';

async function openHost(): Promise<Host<StarterInput>> {
  const runtime = createRuntime({ appId: 'nextjs-langgraph', executors: [createExecutor()] });
  const registry = createRegistry({ components: [Quiz] });
  try {
    const instance = await runtime.create(templateDefinition, {
      principalScope: 'local-demo-principal',
      agent: createTemplateAgent(),
      services: createServices({ mock: createMockModel() }),
      models: {
        providers: { mock: mockDescriptor },
        roles: { comment: { providers: ['mock'], allow: ['in-browser'], maxTokens: 48 } },
        availability: async () => ({ status: 'available' }),
      },
      bindings: starterBindings,
      ui: registry.bindings({ surfaces: ['question'] }),
    });
    return { instance, registry, dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export default function FrameworkHost(): ReactElement {
  return <AgentHost open={openHost} input={starterInput} readResult={readResult} />;
}
