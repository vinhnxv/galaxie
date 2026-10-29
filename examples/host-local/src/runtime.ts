// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter, type LangGraphServices } from '@galaxie/adapter-langgraph';
import {
  type AgentInstance,
  type BindingsFor,
  createRuntime,
  GalaxieError,
  type ModelDescriptor,
  type ModelRouting,
  type OutputSafetyHook,
  type Runtime,
  type SessionId,
} from '@galaxie/core';
import {
  createTutorAgent,
  lessonFixture,
  type ProgressInput,
  type TutorInput,
  tutorDefinition,
} from '@galaxie/example-english-tutor';
import { BuiltInAIChatModel, checkBuiltInAI, prepareBuiltInAI } from '@galaxie/models/builtin-ai';
import { loadWebLLMEngine, WebLLMChatModel, type WebLLMEngineHandle } from '@galaxie/models/webllm';
import { createRegistry, educationComponents, type Registry } from '@galaxie/react';
import { IndexedDBSaver } from '@galaxie/storage-indexeddb';
import { hostAppId, hostLearnerId } from './session.js';
import { allowWorkerScript } from './trusted-types.js';

// The core error vocabulary has no not_found code; this stays in the host binding.
class LessonNotFoundError extends Error {
  readonly code = 'not_found';
  constructor() {
    super('The lesson was not found.');
    this.name = 'LessonNotFoundError';
  }
}

export { hostLearnerId } from './session.js';

const languages = { inputLanguages: ['en'], outputLanguages: ['en'] };

export const localDescriptor: ModelDescriptor = {
  destination: 'in-browser',
  modality: 'text',
  features: ['streaming', 'cancellation', 'structured-output'],
  languages: ['en'],
  pricing: { inputPerToken: 0, outputPerToken: 0 },
};

export interface LocalModels {
  readonly chatModels: LangGraphServices['chatModels'];
  readonly routing: ModelRouting;
}

export type StorageStatus = 'ready' | 'quota' | 'superseded';

export interface LocalHost {
  readonly runtime: Runtime;
  readonly registry: Registry;
  readonly bindings: BindingsFor<typeof tutorDefinition>;
  readonly progress: ReadonlyMap<string, ProgressInput>;
  getStorageStatus(): StorageStatus;
  subscribeStorage(listener: () => void): () => void;
  deleteSession(sessionId: SessionId): Promise<void>;
  createInstance(sessionId?: SessionId): Promise<AgentInstance<TutorInput, unknown>>;
}

// This fixed marker demonstrates the hook seam; it is not a content filter.
export const outputSafety: OutputSafetyHook = ({ text }) =>
  text.includes('GALAXIE_BLOCK_DEMO') ? 'block' : 'allow';

/** All host state is created here, scoped to this local demo learner and runtime. */
export function createLocalHost(models: LocalModels): LocalHost {
  const progress = new Map<string, ProgressInput>();
  const registry = createRegistry({ components: educationComponents });
  const policy = {
    destination: 'in-browser',
    timeoutMs: 1000,
    concurrency: 1,
    grantScope: 'instance',
    approval: 'none',
    retry: 'none',
  } as const;
  const bindings: BindingsFor<typeof tutorDefinition> = {
    'lessons.get@1': {
      ...policy,
      kind: 'read',
      invoke: async ({ lessonId }) => {
        if (lessonId !== lessonFixture.id) throw new LessonNotFoundError();
        return lessonFixture;
      },
    },
    'progress.save@1': {
      ...policy,
      kind: 'write',
      invoke: async ({ lessonId, score, total }) => {
        if (lessonId !== lessonFixture.id)
          throw new GalaxieError('denied', 'The lesson is not allowed.');
        // The learner comes from trusted host context, never from capability arguments.
        progress.set(hostLearnerId, { lessonId, score, total });
        return { saved: true };
      },
    },
  };
  const runtime = createRuntime({
    appId: hostAppId,
    executors: [createLangGraphAdapter()],
    outputSafety,
  });
  let saver: Promise<IndexedDBSaver> | undefined;
  let storageStatus: StorageStatus = 'ready';
  const storageListeners = new Set<() => void>();
  const observeStorage = (status: StorageStatus): void => {
    if (storageStatus === status || storageStatus === 'superseded') return;
    storageStatus = status;
    for (const listener of storageListeners) listener();
  };
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const disposeRuntime = runtime.dispose.bind(runtime);
  runtime.dispose = () => {
    if (disposal === undefined) {
      disposed = true;
      disposal = (async () => {
        await disposeRuntime();
        (await saver?.catch(() => undefined))?.close();
      })();
    }
    return disposal;
  };
  return {
    runtime,
    registry,
    bindings,
    progress,
    getStorageStatus: () => storageStatus,
    subscribeStorage(listener) {
      storageListeners.add(listener);
      return () => storageListeners.delete(listener);
    },
    async deleteSession(sessionId) {
      const checkpointer = await saver;
      await checkpointer?.deleteSession(sessionId);
    },
    async createInstance(sessionId) {
      if (disposed) throw new GalaxieError('invalid', 'The runtime was disposed.');
      let checkpointer: IndexedDBSaver | undefined;
      if (globalThis.indexedDB !== undefined) {
        saver ??= IndexedDBSaver.open({
          appId: hostAppId,
          principalScope: hostLearnerId,
          onError: (code) => {
            if (code === 'quota') observeStorage('quota');
          },
          onVersionChange: () => observeStorage('superseded'),
        }).then(async (opened) => {
          // The caller holds the host's session Web Lock before opening and sweeping.
          try {
            await opened.sweep();
          } catch {}
          return opened;
        });
        try {
          checkpointer = await saver;
        } catch (error) {
          saver = undefined;
          throw error;
        }
      }
      return runtime.create(tutorDefinition, {
        principalScope: hostLearnerId,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(checkpointer === undefined ? {} : { recovery: checkpointer.recovery }),
        agent: createTutorAgent(),
        services: {
          chatModels: models.chatModels,
          ...(checkpointer === undefined ? {} : { checkpointer }),
        },
        models: models.routing,
        bindings,
        ui: registry.bindings({ surfaces: ['lesson-main'] }),
      });
    },
  };
}

/** Called only after an intentional preparation click has loaded the WebLLM handle. */
export function realModels(handle: WebLLMEngineHandle): LocalModels {
  return {
    chatModels: { builtin: new BuiltInAIChatModel(languages), webllm: new WebLLMChatModel(handle) },
    routing: {
      providers: { builtin: localDescriptor, webllm: localDescriptor },
      roles: {
        'quiz.generate': {
          providers: ['builtin', 'webllm'],
          allow: ['in-browser'],
          maxTokens: 2000,
        },
        'tutor.feedback': {
          providers: ['builtin', 'webllm'],
          allow: ['in-browser'],
          maxTokens: 1000,
        },
      },
      availability: async ({ providerId }) => {
        if (providerId === 'webllm') return { status: 'available' };
        const status = await checkBuiltInAI(languages);
        if (status === 'available' || status === 'unavailable') return { status };
        return { status: 'downloadable', siteStorage: false };
      },
      download: async ({ providerId, signal }) => {
        if (providerId !== 'builtin') return false;
        await prepareBuiltInAI({ ...languages, signal });
        return true;
      },
    },
  };
}

export function createWebLLMWorker(): Worker {
  allowWorkerScript();
  return new Worker(new URL('./webllm-worker.ts', import.meta.url), { type: 'module' });
}

export async function prepareLocalModels(): Promise<WebLLMEngineHandle> {
  // Built-in AI is optional; a missing API must still permit the WebLLM route.
  try {
    await prepareBuiltInAI(languages);
  } catch {}
  return loadWebLLMEngine({ worker: createWebLLMWorker() });
}
