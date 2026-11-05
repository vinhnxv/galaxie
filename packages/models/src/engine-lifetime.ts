// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { ModelError } from './errors.js';

/** What the lifetime needs from a Worker: failure events and termination. */
export interface LifetimeWorker {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  terminate(): void;
}

/**
 * Shared by the page-side engine handles: one terminal failure, listeners that race pending work
 * against it, and an idempotent Worker termination.
 */
export class EngineLifetime {
  readonly #worker: LifetimeWorker;
  #failed = false;
  #error: unknown;
  #terminated = false;
  readonly #listeners = new Set<() => void>();

  constructor(worker: LifetimeWorker) {
    this.#worker = worker;
    worker.onerror = (event): void => {
      event.preventDefault();
      this.fail(new ModelError('unavailable', 'worker_failed'));
      this.terminate();
    };
    worker.onmessageerror = (): void => {
      this.fail(new ModelError('unavailable', 'worker_failed'));
      this.terminate();
    };
  }

  get failed(): boolean {
    return this.#failed;
  }
  get error(): unknown {
    return this.#error;
  }

  fail(error: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#error = error;
    for (const listener of this.#listeners) listener();
    this.#listeners.clear();
  }

  subscribe(listener: () => void): () => void {
    if (this.#failed) {
      listener();
      return () => {};
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // A shared pending failure promise would retain every completed chunk until disposal.
  race<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onFailure = (): void => {
        this.#listeners.delete(onFailure);
        reject(this.#error);
      };
      if (this.#failed) onFailure();
      else this.#listeners.add(onFailure);
      // Consume late engine rejections even after failure has already won.
      operation.then(
        (value) => {
          this.#listeners.delete(onFailure);
          resolve(value);
        },
        (error: unknown) => {
          this.#listeners.delete(onFailure);
          reject(error);
        },
      );
    });
  }

  terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#worker.terminate();
  }
}
