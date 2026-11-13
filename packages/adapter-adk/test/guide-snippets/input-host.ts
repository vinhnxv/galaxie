// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type AgentDefinition,
  type AgentInstance,
  type CapabilityBinding,
  type DispatchReceipt,
  defineAgentDefinition,
  type PendingInteraction,
  type RunId,
} from '@galaxie-ai/core';
import { z } from 'zod';

export const questionDefinition: AgentDefinition = defineAgentDefinition({
  id: 'examples/adk-city',
  version: '1.0.0',
  executor: 'adk-js',
  input: z.object({ prompt: z.string() }),
  models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  capabilities: {
    required: {
      'question.ask@1': {
        kind: 'read',
        input: z.object({ message: z.string() }),
        output: z.object({ pending: z.boolean() }),
      },
    },
  },
});

export const questionBinding: CapabilityBinding = {
  kind: 'read',
  destination: 'in-browser',
  timeoutMs: 1000,
  concurrency: 1,
  grantScope: 'instance',
  approval: 'none',
  retry: 'none',
  async invoke() {
    return { pending: true };
  },
};

export function answerCity(
  instance: Pick<AgentInstance<unknown, unknown>, 'instanceId' | 'dispatch'>,
  runId: RunId,
  pending: PendingInteraction,
  city: string,
): Promise<DispatchReceipt> {
  return instance.dispatch({
    instanceId: instance.instanceId,
    runId,
    interactionId: pending.interactionId,
    surfaceId: pending.surfaceId,
    viewRevision: pending.viewRevision,
    action: 'submit',
    payload: { city },
  });
}
