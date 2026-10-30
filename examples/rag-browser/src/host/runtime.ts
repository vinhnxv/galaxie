// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter, type LangGraphServices } from '@galaxie/adapter-langgraph';
import {
  type AgentInstance,
  createRuntime,
  type ModelDescriptor,
  type ModelRouting,
  type Runtime,
} from '@galaxie/core';
import { BuiltInAIChatModel, checkBuiltInAI, prepareBuiltInAI } from '@galaxie/models/builtin-ai';
import { loadWebLLMEngine, WebLLMChatModel } from '@galaxie/models/webllm';
import { ragDefinition } from '../agent/definition.js';
import { createRagAgent } from '../agent/graph.js';
import type { RagInput } from '../agent/schemas.js';
import type { RetrievalClient } from '../retrieval/client.js';
import { createWebLLMWorker } from './trusted-types.js';

export interface RagModels {
  chatModels: LangGraphServices['chatModels'];
  routing: ModelRouting;
  dispose?(): void;
}
export interface RagHost {
  runtime: Runtime;
  instance: AgentInstance<RagInput, unknown>;
  getLastSearchCount(): number | undefined;
  dispose(): Promise<void>;
}
export const localDescriptor: ModelDescriptor = {
  destination: 'in-browser',
  modality: 'text',
  features: ['streaming', 'cancellation'],
  languages: ['en'],
  pricing: { inputPerToken: 0, outputPerToken: 0 },
};
export async function createRagHost(
  retrieval: Pick<RetrievalClient, 'search'>,
  models: RagModels,
): Promise<RagHost> {
  const runtime = createRuntime({
    appId: 'rag-browser',
    executors: [createLangGraphAdapter()],
    outputSafety: ({ text }) => (text.includes('GALAXIE_BLOCK_DEMO') ? 'block' : 'allow'),
    ...(import.meta.env.DEV
      ? { developmentWarnings: (warning) => console.warn('[galaxie]', warning.code) }
      : {}),
  });
  let lastSearchCount: number | undefined;
  try {
    const instance = await runtime.create(ragDefinition, {
      principalScope: 'visitor',
      agent: createRagAgent(),
      services: { chatModels: models.chatModels },
      models: models.routing,
      bindings: {
        'docs.search@1': {
          kind: 'read',
          destination: 'in-browser',
          timeoutMs: 120000,
          concurrency: 1,
          grantScope: 'instance',
          approval: 'none',
          retry: 'none',
          invoke: async (input) => {
            const result = await retrieval.search(input);
            lastSearchCount = result.passages.length;
            return result;
          },
        },
      },
    });
    await instance.prepare();
    return {
      runtime,
      instance,
      getLastSearchCount: () => lastSearchCount,
      async dispose() {
        await runtime.dispose();
        models.dispose?.();
      },
    };
  } catch (error) {
    await runtime.dispose();
    models.dispose?.();
    throw error;
  }
}
export async function prepareRealModels(): Promise<RagModels> {
  const languages = { inputLanguages: ['en'], outputLanguages: ['en'] };
  try {
    await prepareBuiltInAI(languages);
  } catch {}
  const worker = createWebLLMWorker();
  try {
    const handle = await loadWebLLMEngine({ worker });
    return {
      chatModels: {
        builtin: new BuiltInAIChatModel(languages),
        webllm: new WebLLMChatModel(handle),
      },
      routing: {
        providers: { builtin: localDescriptor, webllm: localDescriptor },
        roles: {
          'rag.answer': {
            providers: ['builtin', 'webllm'],
            allow: ['in-browser'],
            maxTokens: 1500,
          },
        },
        availability: async ({ providerId }) => {
          if (providerId === 'webllm') return { status: 'available' };
          const status = await checkBuiltInAI(languages);
          return status === 'available' || status === 'unavailable'
            ? { status }
            : { status: 'downloadable', siteStorage: false };
        },
        download: async ({ providerId, signal }) => {
          if (providerId !== 'builtin') return false;
          await prepareBuiltInAI({ ...languages, signal });
          return true;
        },
      },
      dispose: () => handle.dispose(),
    };
  } catch {
    worker.terminate();
    throw new Error('The chat models could not be prepared.');
  }
}
