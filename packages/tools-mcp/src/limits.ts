// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { failure } from './events.js';

/** Bounds bytes before SDK parsing and signals failures that SDK SSE requests otherwise swallow. */
export class WireLimits {
  readonly #cap: number;
  readonly #idleMs: number;
  readonly #onFailure: () => void;
  readonly #failed = new AbortController();
  readonly #streams = new Set<() => void>();
  #listing: number | undefined;

  constructor(cap: number, idleMs: number, onFailure: () => void) {
    this.#cap = cap;
    this.#idleMs = idleMs;
    this.#onFailure = onFailure;
  }
  get signal(): AbortSignal {
    return this.#failed.signal;
  }
  beginListing(): void {
    this.#listing = 0;
  }
  endListing(): void {
    this.#listing = undefined;
  }
  #fail(): void {
    if (this.signal.aborted) return;
    this.#onFailure();
    this.#failed.abort();
  }
  close(): void {
    for (const stop of this.#streams) stop();
  }

  wrap(response: Response, post: boolean): Response {
    if (response.body === null) return response;
    const reader = response.body.getReader();
    let bytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let sink: ReadableStreamDefaultController<Uint8Array>;
    const cleanup = (): void => {
      clearTimeout(timer);
      this.#streams.delete(stop);
    };
    const stop = (): void => {
      if (finished) return;
      finished = true;
      cleanup();
      void reader.cancel().catch(() => {});
      sink.error(failure());
    };
    const exceed = (): void => {
      stop();
      this.#fail();
    };
    const arm = (): void => {
      if (post) {
        clearTimeout(timer);
        timer = setTimeout(exceed, this.#idleMs);
      }
    };
    const body = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        sink = controller;
        this.#streams.add(stop);
        arm();
      },
      pull: async (controller): Promise<void> => {
        try {
          const chunk = await reader.read();
          if (finished) return;
          if (chunk.done) {
            finished = true;
            cleanup();
            reader.releaseLock();
            controller.close();
            return;
          }
          bytes += chunk.value.byteLength;
          if (post && this.#listing !== undefined) this.#listing += chunk.value.byteLength;
          if (bytes > this.#cap || (this.#listing !== undefined && this.#listing > this.#cap)) {
            exceed();
            return;
          }
          arm();
          controller.enqueue(chunk.value);
        } catch {
          stop();
        }
      },
      cancel: (): void => {
        stop();
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  }

  async request<T>(
    signal: AbortSignal,
    operation: (requestSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let onFailure: () => void = () => {};
    const failed = new Promise<never>((_resolve, reject) => {
      onFailure = (): void => {
        reject(failure());
        controller.abort();
      };
      this.signal.addEventListener('abort', onFailure, { once: true });
    });
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = (): void => {
        reject(failure('cancelled'));
        controller.abort();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      if (this.signal.aborted) throw failure();
      if (signal.aborted) throw failure('cancelled');
      return await Promise.race([
        operation(AbortSignal.any([signal, controller.signal])),
        failed,
        aborted,
      ]);
    } finally {
      this.signal.removeEventListener('abort', onFailure);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
