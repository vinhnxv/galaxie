// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { goBuild } from 'virtual:galaxie-go';
import { createGoAdapter, type GoServices } from '@galaxie-ai/adapter-go';
import type { CapabilityBinding, ModelDescriptor } from '@galaxie-ai/core';
import { MockChatModel } from '@galaxie-ai/models/mock';
import { commentPrompt, createTemplateAgent, templateDefinition } from './agent.js';
import workerUrl from './go-worker.ts?worker&url';
import { createWorker } from './worker-policy.js';

export { createTemplateAgent, templateDefinition };

console.info(`Go starter origin=${goBuild.origin} sha256=${goBuild.wasm.sha256}`);

export function createExecutor(): ReturnType<typeof createGoAdapter> {
  return createGoAdapter({ createWorker: () => createWorker(workerUrl) });
}
export type StarterInput = { prompt: string };
export type ChatModels = Record<string, GoServices['chatModels'][string]>;
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
  saver?: { readonly byteRecords: NonNullable<GoServices['checkpoints']> },
): GoServices {
  return { chatModels, ...(saver === undefined ? {} : { checkpoints: saver.byteRecords }) };
}
export function createGatewayServices(chatModels: ChatModels): GoServices {
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
