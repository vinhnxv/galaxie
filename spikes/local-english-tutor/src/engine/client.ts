// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// The page's handle on the inference worker: load status for the UI, and generate() with streamed
// text and an AbortSignal.

import type {
  EngineInfo,
  FromWorker,
  GenerateRequest,
  GenerationStats,
  LoadProgress,
  ToWorker,
} from './protocol.js';

export type EngineStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'loading'; readonly progress?: LoadProgress }
  | { readonly state: 'ready'; readonly info: EngineInfo }
  | { readonly state: 'failed'; readonly message: string };

export interface GenerateResult {
  readonly text: string;
  readonly stats: GenerationStats;
}

interface Pending {
  readonly onText: (delta: string) => void;
  readonly settle: (outcome: { result: GenerateResult } | { error: Error }) => void;
}

const abortError = (): DOMException => new DOMException('The generation was aborted', 'AbortError');

export class EngineClient {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<() => void>();
  #status: EngineStatus = { state: 'idle' };
  #nextId = 1;

  constructor() {
    this.#worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.#worker.onmessage = (event: MessageEvent<FromWorker>) => this.#receive(event.data);
    this.#worker.onerror = (event) => {
      this.#setStatus({ state: 'failed', message: event.message || 'the worker failed to start' });
    };
  }

  get status(): EngineStatus {
    return this.#status;
  }

  /** For React's useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  load(): void {
    if (this.#status.state === 'idle' || this.#status.state === 'failed') {
      this.#setStatus({ state: 'loading' });
      this.#post({ type: 'load' });
    }
  }

  /** Requests run one at a time in the worker, in the order they arrive. */
  generate(
    request: GenerateRequest,
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<GenerateResult> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = (): void => this.#post({ type: 'abort', id });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, {
        onText,
        settle: (outcome) => {
          signal?.removeEventListener('abort', onAbort);
          if ('error' in outcome) {
            reject(outcome.error);
          } else if (signal?.aborted) {
            reject(abortError());
          } else {
            resolve(outcome.result);
          }
        },
      });
      this.#post({ type: 'generate', id, request });
    });
  }

  #post(message: ToWorker): void {
    this.#worker.postMessage(message);
  }

  #setStatus(status: EngineStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #receive(message: FromWorker): void {
    switch (message.type) {
      case 'progress':
        this.#setStatus({ state: 'loading', progress: message.progress });
        break;
      case 'ready':
        this.#setStatus({ state: 'ready', info: message.info });
        break;
      case 'load-failed':
        this.#setStatus({ state: 'failed', message: message.message });
        break;
      case 'text':
        this.#pending.get(message.id)?.onText(message.delta);
        break;
      case 'done':
        this.#pending.get(message.id)?.settle({ result: message });
        this.#pending.delete(message.id);
        break;
      case 'failed':
        this.#pending.get(message.id)?.settle({ error: new Error(message.message) });
        this.#pending.delete(message.id);
        break;
    }
  }
}
