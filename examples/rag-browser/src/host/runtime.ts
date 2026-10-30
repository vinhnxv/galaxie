// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { pythonBuild } from 'virtual:rag-python';
import { createLangGraphAdapter, type LangGraphServices } from '@galaxie/adapter-langgraph';
import { createPyodideAdapter } from '@galaxie/adapter-pyodide';
import {
  type AgentInstance,
  type CapabilityBinding,
  createRuntime,
  type ModelDescriptor,
  type ModelRouting,
  type Runtime,
} from '@galaxie/core';
import { BuiltInAIChatModel, checkBuiltInAI, prepareBuiltInAI } from '@galaxie/models/builtin-ai';
import { loadWebLLMEngine, WebLLMChatModel } from '@galaxie/models/webllm';
import { ragDefinition } from '../agent/definition.js';
import { pythonRagDefinition } from '../agent/definition-python.js';
import { createRagAgent } from '../agent/graph.js';
import type { RagInput, SearchInput, SearchResult } from '../agent/schemas.js';
import type { RetrievalClient } from '../retrieval/client.js';
import { createPyodideWorker, createWebLLMWorker } from './trusted-types.js';

export interface RagModels {
  chatModels: LangGraphServices['chatModels'];
  routing: ModelRouting;
  dispose?(): void;
}
export interface RagHost {
  runtime: Runtime;
  instance: AgentInstance<RagInput, unknown>;
  readonly executor: 'javascript' | 'python';
  readonly pythonPhase: 'idle' | 'booting' | 'ready' | 'failed';
  readonly pythonColdStartMs: number | undefined;
  selectExecutor(executor: 'javascript' | 'python'): Promise<void>;
  cancelPythonBoot(): Promise<void>;
  subscribeExecutor(listener: () => void): () => void;
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
  let javascript: AgentInstance<RagInput, unknown>;
  let python: AgentInstance<RagInput, unknown> | undefined;
  let active: AgentInstance<RagInput, unknown>;
  let executor: 'javascript' | 'python' = 'javascript';
  let pythonPhase: RagHost['pythonPhase'] = 'idle';
  let pythonColdStartMs: number | undefined;
  let generation = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (): void => {
    if (!disposed) for (const listener of listeners) listener();
  };
  const leavePython = async (): Promise<void> => {
    generation++;
    const previous = python;
    python = undefined;
    executor = 'javascript';
    active = javascript;
    publish();
    await previous?.dispose();
  };
  const pyodide = createPyodideAdapter({
    createWorker: createPyodideWorker,
    runtimeUrl: new URL('/python/runtime/', location.href).href,
    wheelsUrl: new URL('/python/wheels/', location.href).href,
    localWheels: pythonBuild.localWheels,
    onBoot(event) {
      if (disposed || executor !== 'python') return;
      pythonPhase = event.phase;
      if (event.coldStartMs !== undefined) pythonColdStartMs = event.coldStartMs;
      if (event.phase === 'failed') void leavePython().catch(() => {});
      publish();
    },
  });
  const runtime = createRuntime({
    appId: 'rag-browser',
    executors: [createLangGraphAdapter(), pyodide],
    outputSafety: ({ text }) => (text.includes('GALAXIE_BLOCK_DEMO') ? 'block' : 'allow'),
    ...(import.meta.env.DEV
      ? { developmentWarnings: (warning) => console.warn('[galaxie]', warning.code) }
      : {}),
  });
  let lastSearchCount: number | undefined;
  const search: CapabilityBinding<SearchInput, SearchResult> = {
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
  };
  try {
    javascript = await runtime.create(ragDefinition, {
      principalScope: 'visitor',
      agent: createRagAgent(),
      services: { chatModels: models.chatModels },
      models: models.routing,
      bindings: { 'docs.search@1': search },
    });
    active = javascript;
    await javascript.prepare();
    return {
      runtime,
      get instance() {
        return active;
      },
      get executor() {
        return executor;
      },
      get pythonPhase() {
        return pythonPhase;
      },
      get pythonColdStartMs() {
        return pythonColdStartMs;
      },
      subscribeExecutor(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async cancelPythonBoot() {
        pythonPhase = 'idle';
        await leavePython();
      },
      async selectExecutor(selected) {
        if (disposed) return;
        if (selected === 'javascript') {
          pythonPhase = 'idle';
          await leavePython();
          return;
        }
        if (!pythonBuild.available || python || pythonPhase === 'booting') return;
        const current = ++generation;
        executor = 'python';
        pythonPhase = 'booting';
        publish();
        try {
          const next = await runtime.create(pythonRagDefinition, {
            principalScope: 'visitor',
            agent: {
              baseUrl: new URL('/python/agent/', location.href).href,
              files: [
                'rag_agent/__init__.py',
                'rag_agent/graph.py',
                'rag_agent/citations.py',
                'rag_agent/prompt.py',
                'rag_agent/prompt.json',
              ],
              module: 'rag_agent.graph',
              entry: 'create_agent',
            },
            services: { chatModels: models.chatModels },
            models: models.routing,
            bindings: { 'docs.search@1': search },
          });
          if (disposed || current !== generation) {
            await next.dispose();
            return;
          }
          python = next;
          await next.prepare();
          if (disposed || current !== generation) {
            await next.dispose();
            return;
          }
          active = next;
          pythonPhase = 'ready';
          publish();
        } catch {
          if (disposed || current !== generation) return;
          pythonPhase = 'failed';
          await leavePython();
        }
      },
      getLastSearchCount: () => lastSearchCount,
      async dispose() {
        disposed = true;
        generation++;
        await runtime.dispose();
        listeners.clear();
      },
    };
  } catch (error) {
    await runtime.dispose();
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
