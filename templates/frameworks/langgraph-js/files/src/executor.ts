// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter, type LangGraphServices } from '@galaxie-ai/adapter-langgraph';
import type { CapabilityBinding, ModelDescriptor } from '@galaxie-ai/core';
import { MockChatModel } from '@galaxie-ai/models/mock';
import { MemorySaver } from '@langchain/langgraph/web';
import { commentPrompt } from './agent.js';

export { createTemplateAgent, templateDefinition } from './agent.js';
export const createExecutor: typeof createLangGraphAdapter = createLangGraphAdapter;
export type StarterInput = Record<string, never>;
export type ChatModels = Record<string, LangGraphServices['chatModels'][string]>;
export const starterInput: StarterInput = {};
export const mockReply = 'Keep practicing one small step at a time.';
export const gatewayReply = 'This is a fixed reply from the mock upstream.';

export function expectedResult(reply: string): string {
  return `Correct. ${reply}`;
}

export function readResult(output: unknown): string | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const value = (output as Record<string, unknown>)['result'];
  return typeof value === 'string' ? value : undefined;
}

export function createMockModel(): MockChatModel {
  return new MockChatModel({ [commentPrompt]: { id: 'practice-comment', text: mockReply } });
}

export function providerDescriptor(descriptor: ModelDescriptor): ModelDescriptor {
  return descriptor;
}

export function createServices(
  chatModels: ChatModels,
  checkpointer?: LangGraphServices['checkpointer'],
): LangGraphServices {
  return { chatModels, ...(checkpointer === undefined ? {} : { checkpointer }) };
}

export function createGatewayServices(chatModels: ChatModels): LangGraphServices {
  return { chatModels, checkpointer: new MemorySaver() };
}

export const starterBindings: Readonly<Record<string, CapabilityBinding>> = {};

export function expectedOutput(reply: string): unknown {
  return { result: expectedResult(reply) };
}
