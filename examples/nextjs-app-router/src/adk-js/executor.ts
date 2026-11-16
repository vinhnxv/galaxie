// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './adk-env.js';
import type { AdkAgent, AdkServices } from '@galaxie-ai/adapter-adk';
import type { CapabilityBinding, ModelDescriptor } from '@galaxie-ai/core';
import { MockChatModel } from '@galaxie-ai/models/mock';

const adapter = await import('@galaxie-ai/adapter-adk');
const agent = await import('./agent.js');
const { commentPrompt } = agent;

export const templateDefinition: typeof import('./agent.js').templateDefinition =
  agent.templateDefinition;
export function createTemplateAgent(): AdkAgent {
  return agent.createTemplateAgent();
}
export const createExecutor: typeof import('@galaxie-ai/adapter-adk').createAdkAdapter =
  adapter.createAdkAdapter;
export type StarterInput = { prompt: string };
export type ChatModels = Record<string, AdkServices['chatModels'][string]>;
export const starterInput: StarterInput = { prompt: commentPrompt };
export const mockReply = 'Keep practicing one small step at a time.';
export const gatewayReply = 'This is a fixed reply from the mock upstream.';

export function expectedResult(reply: string): string {
  return reply;
}
export function readResult(output: unknown): string | undefined {
  return typeof output === 'string' ? output : undefined;
}
export function createMockModel(): MockChatModel {
  return new MockChatModel(
    {
      [commentPrompt]: [{ id: 'practice-comment', text: mockReply }],
    },
    { sequence: 'assistant-turns' },
  );
}
export function providerDescriptor(descriptor: ModelDescriptor): ModelDescriptor {
  return descriptor;
}
export function createServices(
  chatModels: ChatModels,
  saver?: { readonly byteRecords: NonNullable<AdkServices['checkpoints']> },
): AdkServices {
  return { chatModels, ...(saver === undefined ? {} : { checkpoints: saver.byteRecords }) };
}
export function createGatewayServices(chatModels: ChatModels): AdkServices {
  return { chatModels };
}
export const starterBindings: Readonly<Record<string, CapabilityBinding>> = {
  'question.ask@1': {
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
  },
};

export function expectedOutput(reply: string): unknown {
  return reply;
}
