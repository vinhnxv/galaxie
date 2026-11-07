// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter, type LangGraphServices } from '@galaxie/adapter-langgraph';
import {
  type AgentInstance,
  createRuntime,
  GalaxieError,
  type ModelDescriptor,
  type SessionId,
} from '@galaxie/core';
import { acquireOwnership, type Ownership } from '@galaxie/core/browser';
import {
  BuiltInAIChatModel,
  checkBuiltInAI,
  ModelError,
  type ModelUnavailableReason,
} from '@galaxie/models/builtin-ai';
import { MockChatModel } from '@galaxie/models/mock';
import type { WebLLMEngineHandle, WebLLMProgress } from '@galaxie/models/webllm';
import { createRegistry, Quiz, type Registry } from '@galaxie/react';
import { IndexedDBSaver } from '@galaxie/storage-indexeddb';
import { commentPrompt, createTemplateAgent, templateDefinition } from './agent.js';
import type { WebLLMPhase } from './model-state.js';

export const appId = 'local-only-template';
export const principalScope = 'local-demo-principal';
export const sessionKey: string = `${appId}.${principalScope}.session`;

export interface DownloadOptions {
  readonly signal: AbortSignal;
  readonly onProgress: (progress: WebLLMProgress) => void;
}

export interface TemplateHostOptions {
  readonly builtInAIProbe?: typeof checkBuiltInAI;
  readonly webLLMLoader?: (options: DownloadOptions) => Promise<WebLLMEngineHandle>;
  readonly webGPUProbe?: () => boolean;
}

export interface TemplateModelSnapshot {
  readonly route: 'builtin' | 'mock' | 'webllm';
  readonly builtinReason: ModelUnavailableReason | undefined;
  readonly webllm: WebLLMPhase | undefined;
  readonly progress: number;
}

export type TemplateInstance = AgentInstance<Record<string, never>, unknown>;

export interface TemplateHost {
  readonly registry: Registry;
  getModelSnapshot(): TemplateModelSnapshot;
  subscribeModels(listener: () => void): () => void;
  createInstance(sessionId?: SessionId): Promise<TemplateInstance>;
  downloadWebLLM(): Promise<void>;
  declineDownload(): void;
  cancelDownload(): void;
  dispose(): Promise<void>;
}

const languages = { inputLanguages: ['en'], outputLanguages: ['en'] };
const descriptor: ModelDescriptor = {
  destination: 'in-browser',
  modality: 'text',
  languages: ['en'],
  features: ['streaming', 'cancellation'],
  pricing: { inputPerToken: 0, outputPerToken: 0 },
};

async function loadWebLLM(options: DownloadOptions): Promise<WebLLMEngineHandle> {
  const { downloadWebLLM } = await import('./webllm.js');
  options.signal.throwIfAborted();
  return downloadWebLLM(options);
}

/** No preparation or download occurs during this availability check. */
export async function createTemplateHost(options: TemplateHostOptions = {}): Promise<TemplateHost> {
  let builtinReason: ModelUnavailableReason | undefined;
  try {
    const status = await (options.builtInAIProbe ?? checkBuiltInAI)(languages);
    if (status !== 'available') {
      const api = (globalThis as typeof globalThis & { LanguageModel?: unknown }).LanguageModel;
      builtinReason =
        status === 'unavailable'
          ? api === undefined
            ? 'no_api'
            : 'unsupported_languages'
          : 'download_required';
    }
  } catch (error) {
    builtinReason = error instanceof ModelError ? (error.reason ?? 'no_api') : 'no_api';
  }
  const hasWebGPU = (
    options.webGPUProbe ??
    (() => (globalThis.navigator as (Navigator & { gpu?: unknown }) | undefined)?.gpu !== undefined)
  )();
  let snapshot: TemplateModelSnapshot = {
    route: builtinReason === undefined ? 'builtin' : 'mock',
    builtinReason,
    webllm: builtinReason === undefined ? undefined : hasWebGPU ? 'offer' : 'no_webgpu',
    progress: 0,
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<TemplateModelSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const mock = new MockChatModel({
    [commentPrompt]: { id: 'practice-comment', text: 'Keep practicing one small step at a time.' },
  });
  const chatModels: Record<string, LangGraphServices['chatModels'][string]> = {
    builtin: new BuiltInAIChatModel(languages),
    mock,
    webllm: mock,
  };
  const registry = createRegistry({ components: [Quiz] });
  const runtime = createRuntime({ appId, executors: [createLangGraphAdapter()] });
  let saver: Promise<IndexedDBSaver> | undefined;
  let ownership: Ownership | undefined;
  let controller: AbortController | undefined;
  let engine: WebLLMEngineHandle | undefined;
  let disposal: Promise<void> | undefined;

  const host: TemplateHost = {
    registry,
    getModelSnapshot: () => snapshot,
    subscribeModels(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async createInstance(sessionId) {
      if (disposal !== undefined)
        throw new GalaxieError('invalid', 'The template host was disposed.');
      // Without IndexedDB the adapter uses memory; pending questions then cannot survive reload.
      if (globalThis.indexedDB !== undefined) {
        saver ??= IndexedDBSaver.open({
          appId,
          principalScope,
          onVersionChange: () => {
            void host.dispose().catch(() => {});
          },
        }).catch((error: unknown) => {
          saver = undefined;
          throw error;
        });
      }
      const checkpointer = await saver;
      if (checkpointer !== undefined && ownership === undefined) {
        const acquired = await acquireOwnership({
          appId,
          fence: checkpointer.fencing,
          onHandoverRequest: () => host.dispose(),
        });
        if (acquired.status === 'busy')
          throw new GalaxieError('unavailable', 'The template is active in another tab.');
        ownership = acquired.ownership;
        ownership.signal.addEventListener(
          'abort',
          () => {
            void host.dispose().catch(() => {});
          },
          { once: true },
        );
      }
      if (disposal !== undefined || ownership?.signal.aborted)
        throw new GalaxieError('unavailable', 'The template host is unavailable.');
      return runtime.create(templateDefinition, {
        principalScope,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(checkpointer === undefined ? {} : { recovery: checkpointer.recovery }),
        agent: createTemplateAgent(),
        services: { chatModels, ...(checkpointer === undefined ? {} : { checkpointer }) },
        models: {
          providers: { builtin: descriptor, webllm: descriptor, mock: descriptor },
          roles: {
            comment: {
              providers: ['builtin', 'webllm', 'mock'],
              allow: ['in-browser'],
              maxTokens: 48,
            },
          },
          availability: async ({ providerId }) => ({
            status: providerId === snapshot.route ? 'available' : 'unavailable',
          }),
        },
        bindings: {},
        ui: registry.bindings({ surfaces: ['question'] }),
      });
    },
    async downloadWebLLM() {
      if (
        disposal !== undefined ||
        !['offer', 'failed', 'declined'].includes(snapshot.webllm ?? '')
      )
        return;
      const attempt = new AbortController();
      controller = attempt;
      publish({ webllm: 'downloading', progress: 0 });
      let loaded: WebLLMEngineHandle | undefined;
      try {
        loaded = await (options.webLLMLoader ?? loadWebLLM)({
          signal: attempt.signal,
          onProgress: ({ fraction }) => {
            if (controller === attempt && !attempt.signal.aborted && Number.isFinite(fraction))
              publish({ progress: Math.max(0, Math.min(1, fraction)) });
          },
        });
        if (attempt.signal.aborted) {
          await loaded.dispose();
          return;
        }
        const { WebLLMChatModel } = await import('@galaxie/models/webllm');
        if (attempt.signal.aborted) {
          await loaded.dispose();
          return;
        }
        chatModels['webllm'] = new WebLLMChatModel(loaded);
        engine = loaded;
        publish({ route: 'webllm', webllm: 'ready', progress: 1 });
      } catch {
        await loaded?.dispose().catch(() => {});
        if (controller === attempt && !attempt.signal.aborted)
          publish({ webllm: 'failed', progress: 0 });
      } finally {
        if (controller === attempt) controller = undefined;
      }
    },
    declineDownload() {
      if (disposal === undefined && ['offer', 'failed', 'declined'].includes(snapshot.webllm ?? ''))
        publish({ webllm: 'declined' });
    },
    cancelDownload() {
      if (controller === undefined) return;
      controller.abort();
      controller = undefined;
      publish({ webllm: 'offer', progress: 0 });
    },
    dispose() {
      disposal ??= Promise.resolve().then(async () => {
        controller?.abort();
        listeners.clear();
        try {
          await runtime.dispose();
          await engine?.dispose();
        } finally {
          (await saver?.catch(() => undefined))?.close();
          await ownership?.release();
        }
      });
      return disposal;
    },
  };
  return host;
}
