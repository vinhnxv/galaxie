// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type ErrorCode,
  type ExecutorAdapter,
  type ExecutorAgent,
  type ExecutorEvent,
  isGalaxieError,
  toErrorInfo,
} from '@galaxie/core';
import { parseRunResult } from './bridge.js';
import { adapterFailure, errorCodeOf } from './errors.js';
import {
  type ActiveRun,
  finish,
  type GoServices,
  serveCapability,
  serveModel,
  validServices,
} from './llm.js';
import {
  type BootMessage,
  encodeBoot,
  encodeHostMessage,
  type GoBuildInfo,
  type GoWasmReference,
  type HostMessage,
  parseWorkerMessage,
  sameBuildInfo,
  validUrl,
  validWasmReference,
  type WorkerMessage,
} from './protocol.js';

/** The Go agent a host prepares: the reviewed module and the entry it serves. */
export interface GoAgent {
  readonly wasm: GoWasmReference;
  /** The name the Go program registered with `galaxie.Serve`. */
  readonly entry: string;
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
  /** The toolchain and module versions the program must report; a mismatch fails `unavailable`. */
  readonly expectedBuild?: GoBuildInfo;
  readonly onBoot?: (event: GoBootEvent) => void;
}

export const GO_EXECUTOR_ID = 'adk-go';
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const MAX_READY_TIMEOUT_MS = 120_000;
/** How long a cancelled run may take to settle before the Worker is terminated. */
const CANCEL_GRACE_MS = 500;

function validAgent(agent: unknown): agent is GoAgent {
  if (typeof agent !== 'object' || agent === null || Object.keys(agent).length !== 2) return false;
  const wasm: unknown = Reflect.get(agent, 'wasm');
  const entry: unknown = Reflect.get(agent, 'entry');
  return (
    validWasmReference(wasm) &&
    validUrl(wasm.url) &&
    typeof entry === 'string' &&
    /^[A-Za-z0-9_.-]{1,64}$/.test(entry)
  );
}

function failureCode(error: unknown, fallback: ErrorCode = 'unavailable'): ErrorCode {
  return isGalaxieError(error) ? error.code : fallback;
}

/**
 * The `adk-go` executor adapter. A prepared agent owns one Worker running the reviewed Go module;
 * a run sends the prompt, serves the program's model and capability requests through the run's
 * router and broker, and ends with the final text. Streaming, interactions, resume and durable
 * sessions are not built: their features stay off.
 */
export function createGoAdapter(options: GoAdapterOptions): ExecutorAdapter<GoAgent, GoServices> {
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
        !validServices(services, preparation.models) ||
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
      let disposed = false;
      let active: ActiveRun | undefined;
      let settleRun: ((result: string) => void) | undefined;
      const lost = new Set<string>();
      const conversations = new Map<string, string>();
      let runCounter = 0;
      const send = (message: HostMessage): void => {
        worker.postMessage(encodeHostMessage(message));
      };
      const markDead = (): void => {
        dead = true;
        settleRun?.(JSON.stringify({ ok: false, code: 'unavailable' }));
      };

      const handleCall = (message: Extract<WorkerMessage, { kind: 'call' }>): void => {
        const run = active;
        const reply = (body: { ok: true; payload: string } | { ok: false; code: string }): void => {
          if (active !== run || run?.cancelled || dead) return;
          send({ v: 1, kind: 'reply', runId: message.runId, id: message.id, ...body });
        };
        if (!run || run.cancelled || message.runId !== run.id) {
          send({
            v: 1,
            kind: 'reply',
            runId: message.runId,
            id: message.id,
            ok: false,
            code: 'stale',
          });
          return;
        }
        if (run.seen.has(message.id)) {
          worker.terminate();
          markDead();
          return;
        }
        run.seen.add(message.id);
        void (async () => {
          try {
            const payload =
              message.op === 'model'
                ? await serveModel(run, services, message.payload)
                : await serveCapability(run, message.payload);
            reply({ ok: true, payload });
          } catch (error) {
            reply({ ok: false, code: failureCode(error) });
          }
        })();
      };

      const ready = Promise.withResolvers<{ coldStartMs: number; build?: GoBuildInfo }>();
      let booted = false;
      const receive = (event: { readonly data: unknown }): void => {
        const message = parseWorkerMessage(event.data);
        if (!message) {
          if (!booted) ready.reject(adapterFailure('unavailable'));
          return;
        }
        switch (message.kind) {
          case 'ready':
            booted = true;
            ready.resolve(message);
            return;
          case 'failed':
            ready.reject(adapterFailure('unavailable'));
            return;
          case 'exit':
            ready.reject(adapterFailure('unavailable'));
            markDead();
            return;
          case 'call':
            handleCall(message);
            return;
          case 'done':
            if (active && message.runId === active.id) settleRun?.(message.result);
            return;
        }
      };
      const failed = (): void => {
        ready.reject(adapterFailure('unavailable'));
        markDead();
      };
      worker.addEventListener('message', receive);
      worker.addEventListener('error', failed);
      const teardown = (): void => {
        worker.removeEventListener('message', receive);
        worker.removeEventListener('error', failed);
        worker.terminate();
      };

      const timer = setTimeout(() => ready.reject(adapterFailure('unavailable')), timeoutMs);
      const abortBoot = (): void => ready.reject(adapterFailure('cancelled'));
      preparation.signal.addEventListener('abort', abortBoot, { once: true });
      try {
        if (preparation.signal.aborted) throw adapterFailure('cancelled');
        const message: BootMessage = { v: 1, kind: 'boot', wasm: agent.wasm };
        try {
          worker.postMessage(encodeBoot(message));
        } catch {
          throw adapterFailure('unavailable');
        }
        const report = await ready.promise;
        if (
          options.expectedBuild !== undefined &&
          (report.build === undefined || !sameBuildInfo(report.build, options.expectedBuild))
        )
          throw adapterFailure('unavailable');
        notify({ phase: 'ready', coldStartMs: report.coldStartMs });
      } catch (error) {
        teardown();
        notify({ phase: 'failed' });
        throw error;
      } finally {
        clearTimeout(timer);
        preparation.signal.removeEventListener('abort', abortBoot);
      }

      return {
        async *run(request): AsyncGenerator<ExecutorEvent> {
          let run: ActiveRun | undefined;
          let cancel: (() => void) | undefined;
          let cancellation: Promise<void> | undefined;
          let settled = false;
          try {
            if (disposed || active) throw adapterFailure('invalid');
            if (dead)
              throw adapterFailure(lost.has(request.sessionId) ? 'unrecoverable' : 'unavailable');
            const command = request.command;
            if (command.type !== 'start') throw adapterFailure('unsupported');
            const input: unknown = command.input;
            if (
              typeof input !== 'object' ||
              input === null ||
              Array.isArray(input) ||
              Object.keys(input).length !== 1 ||
              typeof Reflect.get(input, 'prompt') !== 'string'
            )
              throw adapterFailure('invalid');
            if (request.signal.aborted) throw adapterFailure('cancelled');
            let conversation = conversations.get(request.sessionId);
            if (conversation === undefined) {
              conversation = `g${conversations.size + 1}`;
              conversations.set(request.sessionId, conversation);
            }
            const current: ActiveRun = {
              id: `r${++runCounter}`,
              request,
              seen: new Set(),
              leases: new Set(),
              modelCalls: 0,
              cancelled: false,
            };
            run = current;
            active = current;
            const result = new Promise<string>((resolve) => {
              settleRun = resolve;
            });
            cancel = (): void => {
              if (current.cancelled) return;
              current.cancelled = true;
              for (const call of current.leases) finish(current, call);
              cancellation = new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                  // Go did not stop in time; the Worker is the only thing that can end it.
                  lost.add(request.sessionId);
                  worker.terminate();
                  markDead();
                  resolve();
                }, CANCEL_GRACE_MS);
                void result.then(() => {
                  clearTimeout(timeout);
                  resolve();
                });
              });
              try {
                send({ v: 1, kind: 'cancel', runId: current.id });
              } catch {
                // The Worker is gone; the timeout above settles the run.
              }
            };
            request.signal.addEventListener('abort', cancel, { once: true });
            send({
              v: 1,
              kind: 'run',
              runId: current.id,
              request: JSON.stringify({
                entry: agent.entry,
                prompt: Reflect.get(input, 'prompt'),
                conversation,
              }),
            });
            if (request.signal.aborted) cancel();
            const text = await result;
            settled = true;
            const outcome = parseRunResult(text);
            if (!request.signal.aborted) {
              if (outcome.ok) yield { type: 'output', output: outcome.output ?? '' };
              else {
                const code = outcome.code ?? '';
                yield { type: 'error', error: toErrorInfo(errorCodeOf(code)) };
              }
            }
          } catch (error) {
            if (!request.signal.aborted)
              yield { type: 'error', error: toErrorInfo(failureCode(error, 'executor_error')) };
          } finally {
            if (run && settleRun) settleRun = undefined;
            if (cancel) {
              if (!settled) cancel();
              request.signal.removeEventListener('abort', cancel);
            }
            if (cancellation) await cancellation;
            if (run) for (const call of run.leases) finish(run, call);
            if (active === run) active = undefined;
          }
        },
        pending: async () => undefined,
        dispose: async () => {
          disposed = true;
          teardown();
          markDead();
        },
      };
    },
  };
}
