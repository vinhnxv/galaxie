// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { pythonBuild } from 'virtual:rag-python';
import { createLangGraphAdapter, type LangGraphServices } from '@galaxie-ai/adapter-langgraph';
import { createPyodideAdapter } from '@galaxie-ai/adapter-pyodide';
import {
  type AgentInstance,
  type CapabilityBinding,
  createRuntime,
  type ModelDescriptor,
  type ModelRouting,
  type RunId,
  type Runtime,
  type SessionId,
} from '@galaxie-ai/core';
import { acquireOwnership, type Ownership } from '@galaxie-ai/core/browser';
import {
  BuiltInAIChatModel,
  checkBuiltInAI,
  prepareBuiltInAI,
} from '@galaxie-ai/models/builtin-ai';
import { loadWebLLMEngine, WebLLMChatModel } from '@galaxie-ai/models/webllm';
import { IndexedDBSaver } from '@galaxie-ai/storage-indexeddb';
import { z } from 'zod';
import { ragDefinition } from '../agent/definition.js';
import { dspyRagDefinition } from '../agent/definition-dspy.js';
import { pydanticAiRagDefinition } from '../agent/definition-pydantic-ai.js';
import { pythonRagDefinition } from '../agent/definition-python.js';
import { createRagAgent } from '../agent/graph.js';
import type { RagInput, SearchInput, SearchResult } from '../agent/schemas.js';
import type { RetrievalClient } from '../retrieval/client.js';
import { reviewRegistry } from './review-passages.js';
import { appId, principalScope } from './scope.js';
import { createPyodideWorker, createWebLLMWorker } from './trusted-types.js';

const reviewKey = 'galaxie.rag-browser.review';
const savedReviewSchema = z.strictObject({
  executor: z.enum(['javascript', 'python', 'pydantic-ai', 'dspy']),
  sessionId: z.string().min(1).max(128),
});
type SavedReview = z.infer<typeof savedReviewSchema>;
export type RagExecutor = 'javascript' | 'python' | 'pydantic-ai' | 'dspy';

export interface RagModels {
  chatModels: LangGraphServices['chatModels'];
  routing: ModelRouting;
  dispose?(): void;
}
export interface RagHost {
  runtime: Runtime;
  instance: AgentInstance<RagInput, unknown>;
  readonly executor: RagExecutor;
  readonly pydanticAiAvailable: boolean;
  readonly dspyAvailable: boolean;
  readonly pythonPhase: 'idle' | 'booting' | 'ready' | 'failed';
  readonly pythonColdStartMs: number | undefined;
  readonly reviewing: boolean;
  readonly reviewStatus: 'idle' | 'owner' | 'busy' | 'lost';
  readonly reviewRestoreFailed: boolean;
  start(input: RagInput): Promise<{ runId: RunId }>;
  restoreReview(takeover?: boolean): Promise<void>;
  startOver(): Promise<void>;
  selectExecutor(executor: RagExecutor): Promise<void>;
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
  let executor: RagExecutor = 'javascript';
  const pydanticAiAvailable =
    models.routing.roles['rag.answer']?.providers.some((provider) =>
      models.routing.providers[provider]?.features.includes('tool-calling'),
    ) ?? false;
  const dspyAvailable =
    models.routing.roles['rag.answer']?.providers.some((provider) =>
      models.routing.providers[provider]?.features.includes('streaming'),
    ) ?? false;
  let pythonPhase: RagHost['pythonPhase'] = 'idle';
  let pythonColdStartMs: number | undefined;
  let generation = 0;
  let disposed = false;
  let saver: IndexedDBSaver | undefined;
  let ownership: Ownership | undefined;
  let review: AgentInstance<RagInput, unknown> | undefined;
  let unsubscribeReview: (() => void) | undefined;
  let reviewStatus: RagHost['reviewStatus'] = 'idle';
  let reviewRestoreFailed = false;
  let failedReviewReference: SavedReview | undefined;
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
  const pythonAdapter = (
    framework: 'langgraph' | 'pydantic-ai' | 'dspy',
  ): ReturnType<typeof createPyodideAdapter> =>
    createPyodideAdapter({
      framework,
      createWorker: createPyodideWorker,
      runtimeUrl: new URL('/python/runtime/', location.href).href,
      wheelsUrl: new URL('/python/wheels/', location.href).href,
      localWheels: pythonBuild.localWheels,
      onBoot(event) {
        if (disposed || executor !== (framework === 'langgraph' ? 'python' : framework)) return;
        pythonPhase = event.phase;
        if (event.coldStartMs !== undefined) pythonColdStartMs = event.coldStartMs;
        if (event.phase === 'failed' && active !== review) void leavePython().catch(() => {});
        publish();
      },
    });
  const runtime = createRuntime({
    appId,
    executors: [
      createLangGraphAdapter(),
      pythonAdapter('langgraph'),
      pythonAdapter('pydantic-ai'),
      pythonAdapter('dspy'),
    ],
    outputSafety: ({ text }) => (text.includes('GALAXIE_BLOCK_DEMO') ? 'block' : 'allow'),
    ...(import.meta.env.DEV
      ? { developmentWarnings: (warning) => console.warn('[galaxie]', warning.code) }
      : {}),
  });
  const pythonAgent = {
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
  };
  const pydanticAiAgent = {
    ...pythonAgent,
    files: [
      'rag_agent/__init__.py',
      'rag_agent/citations.py',
      'rag_agent/prompt.py',
      'rag_agent/prompt.json',
      'rag_pydantic_ai/__init__.py',
      'rag_pydantic_ai/agent.py',
    ],
    module: 'rag_pydantic_ai.agent',
  };
  const dspyAgent = {
    ...pythonAgent,
    files: [
      'rag_agent/__init__.py',
      'rag_agent/citations.py',
      'rag_agent/prompt.py',
      'rag_agent/prompt.json',
      'rag_dspy/__init__.py',
      'rag_dspy/agent.py',
    ],
    module: 'rag_dspy.agent',
  };
  const selectedPython = (): {
    definition: typeof pythonRagDefinition;
    agent: typeof pythonAgent;
  } =>
    executor === 'dspy'
      ? { definition: dspyRagDefinition, agent: dspyAgent }
      : executor === 'pydantic-ai'
        ? { definition: pydanticAiRagDefinition, agent: pydanticAiAgent }
        : { definition: pythonRagDefinition, agent: pythonAgent };
  const ui = reviewRegistry.bindings({ surfaces: ['rag-review'] });
  const readSavedReview = (): SavedReview | undefined => {
    const value = localStorage.getItem(reviewKey);
    if (value === null) return undefined;
    let parsed: ReturnType<typeof savedReviewSchema.safeParse> | undefined;
    try {
      parsed = savedReviewSchema.safeParse(JSON.parse(value));
    } catch {
      parsed = undefined;
    }
    if (parsed?.success !== true) {
      // A reference that cannot be read names no session, so nothing else can reach or clear it.
      localStorage.removeItem(reviewKey);
      return undefined;
    }
    return parsed.data;
  };
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    generation++;
    await runtime.dispose();
    saver?.close();
    await ownership?.release();
    listeners.clear();
  };
  const openReviewStore = async (takeover = false): Promise<IndexedDBSaver | undefined> => {
    saver ??= await IndexedDBSaver.open({ appId, principalScope });
    if (!ownership) {
      const result = await acquireOwnership({
        appId,
        fence: saver.fencing,
        takeover,
        onHandoverRequest: () => {
          reviewStatus = 'lost';
          publish();
          return dispose();
        },
      });
      if (result.status === 'busy') {
        reviewStatus = 'busy';
        publish();
        return undefined;
      }
      ownership = result.ownership;
      ownership.signal.addEventListener(
        'abort',
        () => {
          if (disposed || ownership?.lostReason === 'released') return;
          reviewStatus = 'lost';
          publish();
          void dispose();
        },
        { once: true },
      );
    }
    if (disposed || !(await ownership.verify())) throw new Error('Review ownership was lost.');
    await saver.sweep();
    reviewStatus = 'owner';
    return saver;
  };
  const openReview = async (saved?: SavedReview, takeover = false): Promise<boolean> => {
    const store = await openReviewStore(takeover);
    if (!store) return false;
    const common = {
      principalScope,
      ...(saved ? { sessionId: saved.sessionId as SessionId } : {}),
      recovery: store.recovery,
      models: models.routing,
      bindings: { 'docs.search@1': search },
      ui,
    };
    review =
      executor !== 'javascript'
        ? await runtime.create(selectedPython().definition, {
            ...common,
            agent: selectedPython().agent,
            services: { chatModels: models.chatModels, checkpoints: store.byteRecords },
          })
        : await runtime.create(ragDefinition, {
            ...common,
            agent: createRagAgent(),
            services: { chatModels: models.chatModels, checkpointer: store },
          });
    active = review;
    reviewStatus = 'owner';
    const prepared = review;
    await prepared.prepare();
    if (disposed || active !== prepared || review !== prepared)
      throw new Error('The review was closed during preparation.');
    if (saved) {
      try {
        await prepared.restore();
      } catch {
        reviewRestoreFailed = true;
        publish();
        return true;
      }
    }
    unsubscribeReview = review.subscribe(() => {
      // Disposal cancels the live run but must retain the durable pending review reference.
      if (disposed) return;
      const run = review?.getSnapshot().run;
      if (run?.status === 'waiting_input')
        localStorage.setItem(reviewKey, JSON.stringify({ executor, sessionId: review?.sessionId }));
      else if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status))
        localStorage.removeItem(reviewKey);
    });
    publish();
    return true;
  };
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
      principalScope,
      agent: createRagAgent(),
      services: { chatModels: models.chatModels },
      models: models.routing,
      bindings: { 'docs.search@1': search },
      ui,
    });
    active = javascript;
    await javascript.prepare();
    const host: RagHost = {
      runtime,
      get instance() {
        return active;
      },
      get executor() {
        return executor;
      },
      pydanticAiAvailable,
      dspyAvailable,
      get pythonPhase() {
        return pythonPhase;
      },
      get pythonColdStartMs() {
        return pythonColdStartMs;
      },
      get reviewing() {
        return (review !== undefined && active === review) || failedReviewReference !== undefined;
      },
      get reviewStatus() {
        return reviewStatus;
      },
      get reviewRestoreFailed() {
        return reviewRestoreFailed;
      },
      async start(input) {
        if (disposed) throw new Error('The runtime was disposed.');
        if (input.review) {
          if (review) await host.startOver();
          const previous = python;
          python = undefined;
          await previous?.dispose();
          if (!(await openReview())) throw new Error('The review is open in another tab.');
        } else {
          const selected = executor;
          if (selected !== 'javascript' && !python) await host.selectExecutor(selected);
          if (executor !== selected)
            throw new Error('The requested executor could not be prepared.');
          active = executor !== 'javascript' ? (python ?? javascript) : javascript;
          publish();
        }
        return active.start(input);
      },
      async restoreReview(takeover = false) {
        let saved = readSavedReview();
        if (!saved && takeover) {
          if (!(await openReviewStore(true))) return;
          saved = readSavedReview();
          if (!saved) {
            await ownership?.release();
            ownership = undefined;
            reviewStatus = 'idle';
            publish();
            return;
          }
        }
        if (!saved) return;
        if (
          saved.executor !== 'javascript' &&
          (!pythonBuild.available ||
            (saved.executor === 'pydantic-ai' && !pydanticAiAvailable) ||
            (saved.executor === 'dspy' && !dspyAvailable))
        ) {
          if (!(await openReviewStore(takeover))) return;
          failedReviewReference = saved;
          reviewRestoreFailed = true;
          publish();
          return;
        }
        executor = saved.executor;
        publish();
        await openReview(saved, takeover);
      },
      async startOver() {
        const sessionId = review?.sessionId ?? failedReviewReference?.sessionId;
        if (!sessionId || !ownership || !(await ownership.verify()))
          throw new Error('Review ownership is required.');
        unsubscribeReview?.();
        await review?.dispose();
        await saver?.deleteSession(sessionId);
        localStorage.removeItem(reviewKey);
        review = undefined;
        reviewRestoreFailed = false;
        failedReviewReference = undefined;
        active = executor !== 'javascript' ? (python ?? javascript) : javascript;
        if (executor !== 'javascript' && !python) pythonPhase = 'idle';
        reviewStatus = 'idle';
        await ownership.release();
        ownership = undefined;
        publish();
      },
      subscribeExecutor(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async cancelPythonBoot() {
        if (active === review) return;
        pythonPhase = 'idle';
        await leavePython();
      },
      async selectExecutor(selected) {
        if (disposed) return;
        if (review || failedReviewReference) return;
        if (selected === 'javascript') {
          pythonPhase = 'idle';
          await leavePython();
          return;
        }
        if (
          !pythonBuild.available ||
          (selected === 'pydantic-ai' && !pydanticAiAvailable) ||
          (selected === 'dspy' && !dspyAvailable) ||
          pythonPhase === 'booting'
        )
          return;
        if (executor === selected && python) return;
        const current = ++generation;
        const previous = python;
        python = undefined;
        active = javascript;
        executor = selected;
        pythonPhase = 'booting';
        publish();
        try {
          await previous?.dispose();
          if (disposed || current !== generation) return;
          const next = await runtime.create(selectedPython().definition, {
            principalScope,
            agent: selectedPython().agent,
            services: { chatModels: models.chatModels },
            models: models.routing,
            bindings: { 'docs.search@1': search },
            ui,
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
      dispose,
    };
    await host.restoreReview();
    return host;
  } catch (error) {
    await dispose();
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
