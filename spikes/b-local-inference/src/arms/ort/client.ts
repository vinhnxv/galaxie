// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Copied from spikes/local-english-tutor/src/engine/; throwaway

import type {
  EngineInfo,
  FromWorker,
  GenerateRequest,
  GenerationStats,
  LoadProgress,
  ToWorker,
} from './protocol.js';
export interface GenerateResult {
  text: string;
  stats: GenerationStats;
  executedIn: string;
}
interface Pending {
  onText: (delta: string) => void;
  resolve: (result: GenerateResult) => void;
  reject: (error: Error) => void;
}
export class EngineClient {
  readonly #worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  readonly #pending = new Map<number, Pending>();
  readonly #controls = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  #nextId = 1;
  #load:
    | {
        resolve: (info: EngineInfo) => void;
        reject: (error: Error) => void;
        progress: (value: LoadProgress) => void;
      }
    | undefined;
  constructor() {
    this.#worker.onmessage = (event: MessageEvent<FromWorker>) => this.#receive(event.data);
    this.#worker.onerror = () => {
      const error = new Error('worker_failed');
      this.#load?.reject(error);
      for (const pending of this.#pending.values()) pending.reject(error);
      for (const control of this.#controls.values()) control.reject(error);
      this.#pending.clear();
      this.#controls.clear();
    };
  }
  load(progress: (value: LoadProgress) => void): Promise<EngineInfo> {
    return new Promise((resolve, reject) => {
      this.#load = { resolve, reject, progress };
      this.#worker.postMessage({ type: 'load' } satisfies ToWorker);
    });
  }
  async openSession(): Promise<number> {
    const id = this.#nextId++;
    await this.#control('open-session', id);
    return id;
  }
  closeSession(id: number): Promise<void> {
    return this.#control('close-session', id);
  }
  #control(type: 'open-session' | 'close-session' | 'dispose', sessionId: number): Promise<void> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#controls.set(id, { resolve, reject });
      this.#worker.postMessage({ type, id, sessionId } satisfies ToWorker);
    });
  }
  generate(
    sessionId: number,
    request: GenerateRequest,
    onText: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<GenerateResult> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const abort = (): void => this.#worker.postMessage({ type: 'abort', id } satisfies ToWorker);
      signal.addEventListener('abort', abort, { once: true });
      this.#pending.set(id, {
        onText,
        resolve: (result) => {
          signal.removeEventListener('abort', abort);
          resolve(result);
        },
        reject: (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      });
      this.#worker.postMessage({ type: 'generate', id, sessionId, request } satisfies ToWorker);
      if (signal.aborted) abort();
    });
  }
  async dispose(): Promise<void> {
    try {
      await this.#control('dispose', 0);
    } finally {
      this.#worker.terminate();
    }
  }
  #receive(message: FromWorker): void {
    switch (message.type) {
      case 'progress':
        this.#load?.progress(message.progress);
        break;
      case 'ready':
        this.#load?.resolve(message.info);
        this.#load = undefined;
        break;
      case 'load-failed':
        this.#load?.reject(new Error('load_failed'));
        this.#load = undefined;
        break;
      case 'text':
        this.#pending.get(message.id)?.onText(message.delta);
        break;
      case 'done':
        this.#pending.get(message.id)?.resolve(message);
        this.#pending.delete(message.id);
        break;
      case 'failed':
        this.#pending.get(message.id)?.reject(new Error('generation_failed'));
        this.#controls.get(message.id)?.reject(new Error('control_failed'));
        this.#pending.delete(message.id);
        this.#controls.delete(message.id);
        break;
      case 'ack':
        this.#controls.get(message.id)?.resolve();
        this.#controls.delete(message.id);
        break;
    }
  }
}
