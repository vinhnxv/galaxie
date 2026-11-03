// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { ModelError } from '../errors.js';
import { classifyTransformersError } from './classify.js';
import { loadVerifiedModelFiles, type ModelFileStore } from './model-files.js';
import { modelCacheName, type TransformersModelRecord } from './model-record.js';
import {
  type FromWorker,
  type LoadPhase,
  maxTextLength,
  parseToWorker,
  type ToWorker,
} from './protocol.js';
import type { LoadedRuntime, OrtAssetUrls, TransformersRuntime } from './runtime.js';

export interface WorkerHostOptions {
  readonly post: (message: FromWorker) => void;
  readonly runtime: TransformersRuntime;
  readonly assets: OrtAssetUrls;
  readonly openStore: (name: string) => Promise<ModelFileStore>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface WorkerHost {
  /** Handles one message from the page; messages that do not match the protocol are ignored. */
  receive(data: unknown): void;
}

/**
 * The Worker side of the protocol: verifies files, starts the runtime and runs one generation at
 * a time. Only fixed codes cross back to the page; the runtime's own text never does.
 */
export function createWorkerHost(options: WorkerHostOptions): WorkerHost {
  const { post, runtime, assets, openStore, fetch: fetcher } = options;
  const now = options.now ?? ((): number => performance.now());
  type State = 'idle' | 'loading' | 'ready' | 'disposed';
  let state: State = 'idle';
  // Reads through a function so the narrowing of earlier assignments does not hide async changes.
  const current = (): State => state;
  let loaded: LoadedRuntime | undefined;
  let record: TransformersModelRecord | undefined;
  let active: { readonly id: number; readonly controller: AbortController } | undefined;

  const fail = (error: unknown, id?: number): void => {
    const failure = classifyTransformersError(error);
    post({
      type: 'failed',
      ...(id === undefined ? {} : { id }),
      code: failure?.code ?? 'provider',
      ...(failure?.reason === undefined ? {} : { reason: failure.reason }),
    });
  };

  async function load(message: Extract<ToWorker, { type: 'load' }>): Promise<void> {
    if (state !== 'idle') {
      fail(undefined);
      return;
    }
    state = 'loading';
    const started = now();
    const progress = (phase: LoadPhase, fraction: number): void =>
      post({
        type: 'progress',
        phase,
        fraction: Math.min(1, Math.max(0, fraction)),
        elapsedSeconds: Math.max(0, (now() - started) / 1000),
      });
    try {
      const store = await openStore(modelCacheName(message.record));
      const files = await loadVerifiedModelFiles({
        record: message.record,
        store,
        allowDownload: message.allowDownload,
        ...(fetcher === undefined ? {} : { fetch: fetcher }),
        onProgress: (step) => progress(step.phase, step.fraction),
      });
      try {
        progress('load', 0);
        loaded = await runtime.load({ record: message.record, cache: files.cache, assets });
      } finally {
        // The runtime has read what it needs, so the verified buffers are dropped.
        files.release();
      }
      if (current() === 'disposed') {
        await loaded.dispose().catch(() => undefined);
        loaded = undefined;
        return;
      }
      record = message.record;
      progress('load', 1);
      state = 'ready';
      post({ type: 'ready', device: loaded.device });
    } catch (error) {
      if (current() !== 'disposed') state = 'idle';
      fail(error);
    }
  }

  async function generate(message: Extract<ToWorker, { type: 'generate' }>): Promise<void> {
    const { id, request } = message;
    if (state !== 'ready' || loaded === undefined || record === undefined || active !== undefined) {
      fail(undefined, id);
      return;
    }
    const controller = new AbortController();
    active = { id, controller };
    try {
      const result = await loaded.generate({
        request,
        contextWindow: record.contextWindow,
        signal: controller.signal,
        onText: (text) => {
          if (controller.signal.aborted) return;
          for (let offset = 0; offset < text.length; offset += maxTextLength)
            post({ type: 'chunk', id, text: text.slice(offset, offset + maxTextLength) });
        },
      });
      post({
        type: 'done',
        id,
        usage: { promptTokens: result.promptTokens, completionTokens: result.completionTokens },
        finishReason: controller.signal.aborted ? 'abort' : result.finishReason,
      });
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof ModelError)) {
        post({
          type: 'done',
          id,
          usage: { promptTokens: 0, completionTokens: 0 },
          finishReason: 'abort',
        });
      } else {
        fail(error, id);
      }
    } finally {
      active = undefined;
    }
  }

  async function dispose(): Promise<void> {
    state = 'disposed';
    active?.controller.abort();
    const engine = loaded;
    loaded = undefined;
    await engine?.dispose().catch(() => undefined);
  }

  return {
    receive(data): void {
      const message = parseToWorker(data);
      if (message === undefined) return;
      switch (message.type) {
        case 'load':
          void load(message);
          break;
        case 'generate':
          void generate(message);
          break;
        case 'abort':
          if (active?.id === message.id) active.controller.abort();
          break;
        case 'dispose':
          void dispose();
          break;
      }
    },
  };
}
