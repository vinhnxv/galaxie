// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type AgentInstance, createRuntime, type SessionId } from '@galaxie/core';
import { acquireOwnership, type Ownership } from '@galaxie/core/browser';
import type { IndexedDBSaver } from '@galaxie/storage-indexeddb';
import { createHostCapabilities } from './capabilities.js';
import { loanConfirmations, loanRegistry } from './loan-approval.js';
import { createOnnxModels, pinnedModelRecord } from './models.js';
import { type RecipeId, recipes } from './registry.js';
import { createOnnxWorker } from './trusted-types.js';

export const loanSessionKey = 'galaxie:adk-recipes:demo:loan';
const appId = 'adk-recipes';

async function openLoanStore(onHandoverRequest: () => Promise<void>): Promise<{
  saver: IndexedDBSaver;
  ownership: Ownership;
}> {
  const { IndexedDBSaver } = await import('@galaxie/storage-indexeddb');
  const saver = await IndexedDBSaver.open({
    databaseName: 'adk-recipes',
    appId,
    principalScope: 'demo',
  });
  try {
    const acquired = await acquireOwnership({ appId, fence: saver.fencing, onHandoverRequest });
    if (acquired.status !== 'owner') throw new Error('The loan is open in another tab.');
    return { saver, ownership: acquired.ownership };
  } catch (error) {
    saver.close();
    throw error;
  }
}

/** Clear a saved pause even when model preparation could not create an active host. */
export async function clearSavedLoan(): Promise<void> {
  const sessionId = sessionStorage.getItem(loanSessionKey);
  if (!sessionId) return;
  const store = await openLoanStore(async () => {});
  try {
    await store.saver.deleteSession(sessionId);
    sessionStorage.removeItem(loanSessionKey);
  } finally {
    await store.ownership.release();
    store.saver.close();
  }
}

export interface RecipeHost {
  readonly instance: AgentInstance<unknown, unknown>;
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  prepare(): Promise<void>;
  dispose(): Promise<void>;
  clear(): Promise<void>;
}

/** One host and one executor per document. Switching or clearing loads a fresh document. */
export async function createRecipeHost(id: RecipeId, signal: AbortSignal): Promise<RecipeHost> {
  const recipe = recipes.find((entry) => entry.id === id);
  if (!recipe?.available) throw new Error('The selected recipe is unavailable.');
  signal.throwIfAborted();
  const selected = await recipe.load();
  signal.throwIfAborted();
  const models =
    import.meta.env.MODE === 'mock'
      ? recipe.models()
      : createOnnxModels(recipe.definition, pinnedModelRecord, {
          createWorker: createOnnxWorker,
          confirmDownload: ({ bytes }) =>
            confirm(
              `Download Qwen3.5-0.8B (Apache-2.0) from Hugging Face? ${Math.round((bytes ?? 0) / 1_000_000)} MB will be stored on this device. No real-model result is claimed.`,
            ),
        });
  if (
    Object.keys(models.routing.roles).length !== Object.keys(recipe.definition.models ?? {}).length
  )
    throw new Error('The selected recipe has no usable model record.');
  const capabilities = createHostCapabilities('demo');
  const { 'market.search@1': search, ...loanBindings } = capabilities.bindings;
  let saver: IndexedDBSaver | undefined;
  let ownership: Ownership | undefined;
  let instance: AgentInstance<unknown, unknown> | undefined;
  let unsubscribe: (() => void) | undefined;
  const runtime = createRuntime({
    appId,
    executors: [selected.executor],
    budgets: { steps: 20, toolCalls: 8, tokens: 40000 },
    // Demonstration hook only. Every routed reply and growing chunk passes through core.
    outputSafety: () => 'allow',
  });
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposal ??= (async () => {
      unsubscribe?.();
      try {
        const run = instance?.getSnapshot().run;
        if (run && ['queued', 'running', 'waiting_input'].includes(run.status))
          await instance?.cancel(run.runId);
        await runtime.dispose();
      } finally {
        if ('dispose' in models) await models.dispose();
        await ownership?.release();
        saver?.close();
      }
    })();
    return disposal;
  };
  try {
    const loan = id === 'loan';
    if (loan) {
      ({ saver, ownership } = await openLoanStore(dispose));
      ownership.signal.addEventListener(
        'abort',
        () => {
          void dispose().catch(() => undefined);
        },
        { once: true },
      );
    }
    signal.throwIfAborted();
    const sessionId = loan ? sessionStorage.getItem(loanSessionKey) : null;
    instance = await runtime.create(recipe.definition, {
      principalScope: 'demo',
      agent: selected.agent,
      models: models.routing,
      bindings: loan ? loanBindings : { 'market.search@1': search },
      services: {
        chatModels: models.chatModels,
        ...(saver ? { checkpoints: saver.byteRecords } : {}),
      },
      ...(saver ? { recovery: saver.recovery } : {}),
      ...(sessionId ? { sessionId: sessionId as SessionId } : {}),
      ...(loan
        ? {
            ui: loanRegistry.bindings({ surfaces: ['main'] }),
            confirmations: {
              capabilities: loanConfirmations.capabilities,
              policyRevision: () => 'loan-1',
              signals: [signal, ...(ownership ? [ownership.signal] : [])],
            },
          }
        : {}),
    });
    const active = instance;
    if (loan) {
      unsubscribe = active.subscribe(() => {
        const status = active.getSnapshot().run?.status;
        if (status === 'waiting_input') sessionStorage.setItem(loanSessionKey, active.sessionId);
        else if (status === 'succeeded') sessionStorage.removeItem(loanSessionKey);
      });
    }
    signal.addEventListener(
      'abort',
      () => {
        void dispose().catch(() => undefined);
      },
      { once: true },
    );
    if (signal.aborted) {
      await dispose();
      signal.throwIfAborted();
    }
    return {
      instance: active,
      capabilities,
      async prepare() {
        await active.prepare();
        signal.throwIfAborted();
      },
      dispose,
      async clear() {
        // Settle writes before deleting, while the saver still owns the app fence.
        const run = active.getSnapshot().run;
        if (run) await active.cancel(run.runId);
        await runtime.dispose();
        await saver?.deleteSession(active.sessionId);
        if (loan) sessionStorage.removeItem(loanSessionKey);
        await dispose();
      },
    };
  } catch (error) {
    // A failed disposal must not replace the error that ended the setup.
    await dispose().catch(() => undefined);
    throw error;
  }
}
