// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationRequest, GenerationResult, LoadInfo, Message, Session } from './types.js';

type WireRequest = Omit<GenerationRequest, 'signal' | 'onChunk'>;
type Command = {
  id: number;
  op: 'load' | 'open' | 'close' | 'generate' | 'dispose' | 'abort';
  session?: number;
  request?: WireRequest;
};
type Reply =
  | { id: number; kind: 'result'; value: unknown }
  | { id: number; kind: 'chunk'; text: string }
  | { id: number; kind: 'progress'; loaded: number; total?: number }
  | { id: number; kind: 'error'; message?: string };
export class WorkerClient {
  #next = 1;
  #failure: Error | undefined;
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  // Keep chunk observers until session close so the harness can observe a late chunk after settle.
  #chunks = new Map<number, { session: number; emit: (text: string) => void }>();
  #progress: ((loaded: number, total?: number) => void) | undefined;
  readonly worker: Worker;
  constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<Reply>) => {
      const reply = event.data;
      if (reply.kind === 'chunk') {
        this.#chunks.get(reply.id)?.emit(reply.text);
        return;
      }
      if (reply.kind === 'progress') {
        this.#progress?.(reply.loaded, reply.total);
        return;
      }
      const pending = this.#pending.get(reply.id);
      this.#pending.delete(reply.id);
      if (reply.kind === 'error')
        pending?.reject(new Error(reply.message ?? 'worker_request_failed'));
      else pending?.resolve(reply.value);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.#failure = new Error('worker_failed');
      for (const pending of this.#pending.values()) pending.reject(new Error('worker_failed'));
      this.#pending.clear();
    };
  }
  #call<T>(
    op: Command['op'],
    extra: { session?: number; request?: WireRequest } = {},
    request?: GenerationRequest,
  ): Promise<T> {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => this.worker.postMessage({ id, op: 'abort' } satisfies Command);
      this.#pending.set(id, {
        resolve: (value) => {
          request?.signal.removeEventListener('abort', abort);
          resolve(value as T);
        },
        reject: (error) => {
          request?.signal.removeEventListener('abort', abort);
          reject(error);
        },
      });
      if (request) {
        this.#chunks.set(id, { session: extra.session ?? 0, emit: request.onChunk });
        request.signal.addEventListener('abort', abort, { once: true });
      }
      this.worker.postMessage({ id, op, ...extra } satisfies Command);
      if (request?.signal.aborted) abort();
    });
  }
  async load(progress: (loaded: number, total?: number) => void): Promise<LoadInfo> {
    this.#progress = progress;
    return this.#call('load');
  }
  async openSession(): Promise<Session> {
    const session = await this.#call<number>('open');
    return {
      generate: (request) => {
        const { signal: _signal, onChunk: _onChunk, ...wire } = request;
        return this.#call<GenerationResult>('generate', { session, request: wire }, request);
      },
      close: async () => {
        await this.#call('close', { session });
        for (const [id, item] of this.#chunks)
          if (item.session === session) this.#chunks.delete(id);
      },
    };
  }
  async dispose(): Promise<void> {
    try {
      await this.#call('dispose');
    } finally {
      this.worker.terminate();
      this.#chunks.clear();
    }
  }
}
export interface WorkerBackend {
  load(progress: (loaded: number, total?: number) => void): Promise<LoadInfo>;
  generate(
    request: WireRequest,
    history: Message[],
    signal: AbortSignal,
    emit: (text: string) => void,
  ): Promise<Omit<GenerationResult, 'executedIn'>>;
  dispose(): Promise<void>;
}
export function serveWorker(backend: WorkerBackend): void {
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  const sessions = new Map<number, Message[]>();
  const controllers = new Map<number, AbortController>();
  let next = 1;
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
      let value: unknown = null;
      try {
        switch (command.op) {
          case 'load':
            value = await backend.load((loaded, total) =>
              scope.postMessage({
                kind: 'progress',
                id: command.id,
                loaded,
                ...(total === undefined ? {} : { total }),
              } satisfies Reply),
            );
            break;
          case 'open':
            value = next++;
            sessions.set(value as number, []);
            break;
          case 'close':
            sessions.delete(command.session ?? -1);
            break;
          case 'dispose':
            await backend.dispose();
            sessions.clear();
            break;
          case 'generate': {
            const history = sessions.get(command.session ?? -1);
            if (!history || !command.request) throw new Error('unknown_session');
            const result = await backend.generate(
              command.request,
              history,
              controller.signal,
              (text) => scope.postMessage({ kind: 'chunk', id: command.id, text } satisfies Reply),
            );
            if (!result.aborted)
              history.push(...command.request.messages, {
                role: 'assistant',
                content: result.text,
              });
            value = { ...result, executedIn: scope.constructor.name };
            break;
          }
        }
        scope.postMessage({ kind: 'result', id: command.id, value } satisfies Reply);
      } catch (error) {
        // Only load errors carry a message: generation errors could quote model text.
        scope.postMessage({
          kind: 'error',
          id: command.id,
          ...(command.op === 'load' && error instanceof Error
            ? { message: error.message.slice(0, 600) }
            : {}),
        } satisfies Reply);
      } finally {
        controllers.delete(command.id);
      }
    });
  };
}
