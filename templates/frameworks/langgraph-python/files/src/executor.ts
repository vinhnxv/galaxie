// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { pythonBuild } from 'virtual:galaxie-python';
import { createPyodideAdapter, type PyodideServices } from '@galaxie-ai/adapter-pyodide';
import type { CapabilityBinding, ModelDescriptor } from '@galaxie-ai/core';
import { MockChatModel } from '@galaxie-ai/models/mock';
import { commentPrompt } from './agent.js';
import workerUrl from './pyodide-worker.ts?worker&url';
import { createWorker } from './worker-policy.js';

export { createTemplateAgent, templateDefinition } from './agent.js';

console.info(`Python starter origin=source sha256=${pythonBuild.sourceSha256}`);

export function createExecutor(): ReturnType<typeof createPyodideAdapter> {
  return createPyodideAdapter({
    framework: 'langgraph',
    createWorker: () => createWorker(workerUrl),
    runtimeUrl: new URL(pythonBuild.runtimeUrl, location.href).href,
    wheelsUrl: new URL(pythonBuild.wheelsUrl, location.href).href,
    localWheels: pythonBuild.localWheels,
  });
}
export type StarterInput = Record<string, never>;
export type ChatModels = Record<string, PyodideServices['chatModels'][string]>;
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
  saver?: { readonly byteRecords: NonNullable<PyodideServices['checkpoints']> },
): PyodideServices {
  return { chatModels, ...(saver === undefined ? {} : { checkpoints: saver.byteRecords }) };
}
export function createGatewayServices(chatModels: ChatModels): PyodideServices {
  return { chatModels };
}
export const starterBindings: Readonly<Record<string, CapabilityBinding>> = {};
export function expectedOutput(reply: string): unknown {
  return { result: expectedResult(reply) };
}
