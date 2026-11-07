// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Adapted from spikes/b-local-inference/src/arms/worker-rpc.ts; fixed content-free errors.
import type { FileVerification, Reason } from '../results.js';
import { ArmFailure } from './types.js';

export interface Command {
  id: number;
  op: 'load' | 'decide' | 'dispose' | 'abort';
  value?: unknown;
}
type Reply =
  | { id: number; kind: 'result'; value: unknown }
  | { id: number; kind: 'progress'; loaded: number; total: number | null }
  | { id: number; kind: 'error'; reason: Reason; files: FileVerification[] };
export class WorkerClient {
  readonly worker: Worker;
  #next = 1;
  #failed = false;
  #pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      progress(loaded: number, total: number | null): void;
    }
  >();
  constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<Reply>) => {
      const reply = event.data;
      const pending = this.#pending.get(reply.id);
      if (reply.kind === 'progress') {
        pending?.progress(reply.loaded, reply.total);
        return;
      }
      this.#pending.delete(reply.id);
      if (reply.kind === 'error') pending?.reject(new ArmFailure(reply.reason, reply.files));
      else pending?.resolve(reply.value);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.#failed = true;
      for (const pending of this.#pending.values()) pending.reject(new ArmFailure('worker_failed'));
      this.#pending.clear();
    };
  }
  call<T>(
    op: Command['op'],
    value?: unknown,
    signal?: AbortSignal,
    progress: (loaded: number, total: number | null) => void = () => {},
  ): Promise<T> {
    if (this.#failed) return Promise.reject(new ArmFailure('worker_failed'));
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => this.worker.postMessage({ id, op: 'abort' } satisfies Command);
      const clean = (): void => signal?.removeEventListener('abort', abort);
      this.#pending.set(id, {
        resolve: (result) => {
          clean();
          resolve(result as T);
        },
        reject: (error) => {
          clean();
          reject(error);
        },
        progress,
      });
      signal?.addEventListener('abort', abort, { once: true });
      this.worker.postMessage({ id, op, value } satisfies Command);
      if (signal?.aborted) abort();
    });
  }
  terminate(): void {
    this.#failed = true;
    this.worker.terminate();
    for (const pending of this.#pending.values()) pending.reject(new ArmFailure('worker_failed'));
    this.#pending.clear();
  }
}
export function serveWorker(backend: {
  load(value: unknown, progress: (loaded: number, total: number | null) => void): Promise<unknown>;
  decide(value: unknown, signal: AbortSignal): Promise<unknown>;
  dispose(): Promise<void>;
}): void {
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  const controllers = new Map<number, AbortController>();
  let queue = Promise.resolve();
  scope.onmessage = (event: MessageEvent<Command>) => {
    const command = event.data;
    if (command.op === 'abort') {
      controllers.get(command.id)?.abort();
      return;
    }
    const controller = new AbortController();
    controllers.set(command.id, controller);
    queue = queue.then(async () => {
      try {
        const value =
          command.op === 'load'
            ? await backend.load(command.value, (loaded, total) =>
                scope.postMessage({
                  id: command.id,
                  kind: 'progress',
                  loaded,
                  total,
                } satisfies Reply),
              )
            : command.op === 'decide'
              ? await backend.decide(command.value, controller.signal)
              : await backend.dispose();
        scope.postMessage({ id: command.id, kind: 'result', value } satisfies Reply);
      } catch (error) {
        const failure =
          error instanceof ArmFailure
            ? error
            : new ArmFailure(command.op === 'load' ? 'load_failed' : 'inference_failed');
        scope.postMessage({
          id: command.id,
          kind: 'error',
          reason: failure.reason,
          files: failure.files,
        } satisfies Reply);
      } finally {
        controllers.delete(command.id);
      }
    });
  };
}
