// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ExecutorAdapter, ExecutorAgent, ExecutorEvent } from '@galaxie/core';
import { adapterFailure } from './errors.js';
import {
  type BootMessage,
  encodeBoot,
  type GoWasmReference,
  parseWorkerMessage,
  validUrl,
  validWasmReference,
} from './protocol.js';

/** The Go agent a host prepares: the reviewed module. */
export interface GoAgent {
  readonly wasm: GoWasmReference;
}

export interface GoWorkerPort {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: 'error', listener: () => void): void;
  terminate(): void;
}

export interface GoBootEvent {
  readonly phase: 'booting' | 'ready' | 'failed';
  readonly coldStartMs?: number;
}

export interface GoAdapterOptions {
  /** Builds a dedicated Worker running `@galaxie/adapter-go/worker`; prepare builds a new one each time. */
  readonly createWorker: () => GoWorkerPort;
  /** How long a boot may take before the Worker is terminated; defaults to 30 seconds. */
  readonly readyTimeoutMs?: number;
  readonly onBoot?: (event: GoBootEvent) => void;
}

export const GO_EXECUTOR_ID = 'adk-go';
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const MAX_READY_TIMEOUT_MS = 120_000;

function validAgent(agent: unknown): agent is GoAgent {
  if (typeof agent !== 'object' || agent === null || Object.keys(agent).length !== 1) return false;
  const wasm: unknown = Reflect.get(agent, 'wasm');
  return validWasmReference(wasm) && validUrl(wasm.url);
}

/** Boots one Worker and settles when it reports ready; any other outcome terminates it. */
function boot(
  worker: GoWorkerPort,
  message: BootMessage,
  timeoutMs: number,
  signal: AbortSignal,
  onDead: () => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, coldStartMs?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      if (error !== undefined) {
        worker.removeEventListener('message', receive);
        worker.removeEventListener('error', failed);
        worker.terminate();
        reject(error);
      } else resolve(coldStartMs ?? 0);
    };
    const receive = (event: { readonly data: unknown }): void => {
      const reply = parseWorkerMessage(event.data);
      if (settled) {
        if (reply?.kind === 'exit') onDead();
        return;
      }
      if (reply?.kind === 'ready') finish(undefined, reply.coldStartMs);
      else finish(adapterFailure('unavailable'));
    };
    const failed = (): void => {
      if (settled) onDead();
      else finish(adapterFailure('unavailable'));
    };
    const aborted = (): void => finish(adapterFailure('cancelled'));
    const timer = setTimeout(() => finish(adapterFailure('unavailable')), timeoutMs);
    worker.addEventListener('message', receive);
    worker.addEventListener('error', failed);
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    try {
      worker.postMessage(encodeBoot(message));
    } catch {
      finish(adapterFailure('unavailable'));
    }
  });
}

/**
 * The `adk-go` executor adapter. Stage AG1 boots and verifies the Worker; every feature stays off
 * and a run fails `unsupported` until the model and tool bridge exist.
 */
export function createGoAdapter(options: GoAdapterOptions): ExecutorAdapter<GoAgent, undefined> {
  return {
    id: GO_EXECUTOR_ID,
    version: '0.0.0',
    features: {
      interrupts: false,
      resume: false,
      checkpoints: false,
      streaming: false,
      subgraphs: false,
    },
    async prepare(agent, services, preparation): Promise<ExecutorAgent> {
      const timeoutMs = options?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
      if (
        services !== undefined ||
        !validAgent(agent) ||
        typeof options?.createWorker !== 'function' ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > MAX_READY_TIMEOUT_MS
      )
        throw adapterFailure('invalid');
      const notify = (event: GoBootEvent): void => {
        try {
          options.onBoot?.(event);
        } catch {
          // A host callback never changes the outcome of the boot.
        }
      };
      notify({ phase: 'booting' });
      let worker: GoWorkerPort;
      try {
        worker = options.createWorker();
      } catch {
        notify({ phase: 'failed' });
        throw adapterFailure('unavailable');
      }
      let dead = false;
      try {
        const coldStartMs = await boot(
          worker,
          { v: 1, kind: 'boot', wasm: agent.wasm },
          timeoutMs,
          preparation.signal,
          () => {
            dead = true;
          },
        );
        notify({ phase: 'ready', coldStartMs });
      } catch (error) {
        notify({ phase: 'failed' });
        throw error;
      }
      return {
        run(): AsyncIterable<ExecutorEvent> {
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.reject(adapterFailure(dead ? 'unavailable' : 'unsupported')),
            }),
          };
        },
        pending: async () => undefined,
        dispose: async () => {
          worker.terminate();
        },
      };
    },
  };
}
