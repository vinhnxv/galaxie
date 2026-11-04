// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type ErrorCode,
  type ExecutorAdapter,
  type ExecutorAgent,
  type ExecutorEvent,
  type InteractionId,
  isGalaxieError,
  type PendingInteraction,
  toErrorInfo,
} from '@galaxie/core';
import { parseRunResult } from './bridge.js';
import { loadConversation, saveConversation } from './checkpoints.js';
import { adapterFailure, errorCodeOf } from './errors.js';
import {
  type ActiveRun,
  finish,
  type GoServices,
  serveCapability,
  serveModel,
  validServices,
} from './llm.js';
import { newKey, restoredContent, type StoredConversation } from './persist.js';
import {
  type BootMessage,
  encodeBoot,
  encodeHostMessage,
  failedRun,
  GO_EXECUTOR_ID,
  type GoBuildInfo,
  type GoWasmReference,
  type HostMessage,
  parseWorkerMessage,
  sameBuildInfo,
  validUrl,
  validWasmReference,
  type WorkerMessage,
  withinBridgeLimit,
} from './protocol.js';
import { emitPaused } from './stream.js';

/** The Go agent a host prepares: the reviewed module and the entry it serves. */
export interface GoAgent {
  readonly wasm: GoWasmReference;
  /** The name the Go program registered with `galaxie.Serve` or `galaxie.ServeWith`. */
  readonly entry: string;
  /**
   * Asks the run for `stream` events: checked text deltas as `messages` and content-free tool
   * markers as `updates`. Absent or false, a run emits only its output.
   */
  readonly stream?: boolean;
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

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const MAX_READY_TIMEOUT_MS = 120_000;
const CANCEL_GRACE_MS = 500;

function validAgent(agent: unknown): agent is GoAgent {
  if (typeof agent !== 'object' || agent === null) return false;
  const stream: unknown = Reflect.get(agent, 'stream');
  const expected = stream === undefined ? 2 : 3;
  if (
    Object.keys(agent).length !== expected ||
    (stream !== undefined && typeof stream !== 'boolean')
  )
    return false;
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
 * router and broker, and ends with the final text. With `stream` set, the checked text of each
 * model reply also reaches the host while it is produced. A confirmation or long-running tool ends
 * the run with one interaction, and the answer arrives as a new run that continues the paused
 * session. With `services.checkpoints` the program returns the whole conversation as a record after
 * each pause or completion and the adapter stores it, so a pause survives a reload or a lost Worker
 * and a fresh instance continues it from the record alone; without it the paused session lives in
 * the Worker and only as long as the Worker.
 */
export function createGoAdapter(options: GoAdapterOptions): ExecutorAdapter<GoAgent, GoServices> {
  return {
    id: GO_EXECUTOR_ID,
    version: '0.0.0',
    features: {
      interrupts: true,
      resume: true,
      checkpoints: true,
      streaming: true,
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
        } catch {}
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
      const store = services.checkpoints;
      // The durable state of each hydrated session; the pause map below mirrors its pause.
      const stored = new Map<string, StoredConversation>();
      const known = new Set<string>();
      const loading = new Map<string, Promise<void>>();
      // The pause each session waits on, with where its stream markers continue so a resumed run
      // never repeats an index; the Go session behind it lives in the Worker.
      const pauses = new Map<string, { interaction: PendingInteraction; position: number }>();
      let runCounter = 0;
      const send = (message: HostMessage): void => {
        worker.postMessage(encodeHostMessage(message));
      };
      const markDead = (): void => {
        dead = true;
        // Without a store the paused session lived in the Worker; with one, the record holds it.
        if (store === undefined) {
          for (const sessionId of pauses.keys()) lost.add(sessionId);
          pauses.clear();
        }
        settleRun?.(failedRun('unavailable'));
      };
      /** Reads a session's stored conversation once, registering its text as private first. */
      const load = async (
        sessionId: string,
        register: ((value: unknown) => void) | undefined,
      ): Promise<void> => {
        if (store === undefined) return;
        const found = await loadConversation(store, sessionId);
        if (found !== undefined) {
          if (register === undefined) throw adapterFailure('unsupported');
          try {
            register(restoredContent(found.record));
          } catch (error) {
            const code = isGalaxieError(error) ? error.code : 'unrecoverable';
            throw adapterFailure(code === 'stale' || code === 'cancelled' ? code : 'unrecoverable');
          }
          if (disposed) return;
          stored.set(sessionId, found);
          conversations.set(sessionId, found.conversation);
          if (found.pause !== undefined)
            pauses.set(sessionId, { interaction: found.pause, position: found.position });
        }
        known.add(sessionId);
      };
      const hydrate = (
        sessionId: string,
        register: ((value: unknown) => void) | undefined,
      ): Promise<void> => {
        if (store === undefined || disposed || known.has(sessionId)) return Promise.resolve();
        let reading = loading.get(sessionId);
        if (reading === undefined) {
          reading = load(sessionId, register).finally(() => loading.delete(sessionId));
          loading.set(sessionId, reading);
        }
        return reading;
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
          // The pause this run took from the map, and whether the run ended in a stored state. A
          // run that does not commit leaves the store as it was, so the pause comes back.
          let consumed: { interaction: PendingInteraction; position: number } | undefined;
          let committed = false;
          try {
            const usable = (): void => {
              if (disposed || active) throw adapterFailure('invalid');
              if (dead)
                throw adapterFailure(lost.has(request.sessionId) ? 'unrecoverable' : 'unavailable');
            };
            usable();
            if (store !== undefined) {
              await hydrate(request.sessionId, request.registerRestoredData);
              // The hydrate awaited: the instance may have been disposed or taken by another run.
              usable();
              const held = stored.get(request.sessionId);
              if (held !== undefined) {
                // Core clears its private values at every run end, so the stored history is
                // registered again for each run that can replay it.
                if (request.registerRestoredData === undefined) throw adapterFailure('unsupported');
                try {
                  request.registerRestoredData(restoredContent(held.record));
                } catch (error) {
                  const code = isGalaxieError(error) ? error.code : 'unrecoverable';
                  throw adapterFailure(
                    code === 'stale' || code === 'cancelled' ? code : 'unrecoverable',
                  );
                }
              }
            }
            const command = request.command;
            let answer: { interactionId: string; action: string; payload: unknown } | undefined;
            let prompt = '';
            let position = 0;
            if (command.type === 'start') {
              const input: unknown = command.input;
              if (
                typeof input !== 'object' ||
                input === null ||
                Array.isArray(input) ||
                Object.keys(input).length !== 1 ||
                typeof Reflect.get(input, 'prompt') !== 'string'
              )
                throw adapterFailure('invalid');
              prompt = Reflect.get(input, 'prompt') as string;
              consumed = pauses.get(request.sessionId);
              pauses.delete(request.sessionId);
            } else {
              const waiting = pauses.get(request.sessionId);
              if (
                waiting === undefined ||
                waiting.interaction.interactionId !== command.interactionId
              )
                throw adapterFailure('stale');
              position = waiting.position;
              consumed = waiting;
              pauses.delete(request.sessionId);
              answer = {
                interactionId: command.interactionId,
                action: command.action,
                payload: command.payload,
              };
            }
            if (request.signal.aborted) throw adapterFailure('cancelled');
            let conversation = conversations.get(request.sessionId);
            if (conversation === undefined) {
              conversation = `g${conversations.size + 1}`;
              conversations.set(request.sessionId, conversation);
            }
            let runRequest: string;
            const held = stored.get(request.sessionId);
            try {
              runRequest = JSON.stringify({
                entry: agent.entry,
                prompt,
                conversation,
                ...(agent.stream === true ? { stream: true } : {}),
                ...(answer === undefined ? {} : { resume: answer }),
                ...(store === undefined ? {} : { persist: true }),
                ...(held === undefined ? {} : { restore: held.record }),
              });
            } catch {
              throw adapterFailure('invalid');
            }
            if (!withinBridgeLimit(runRequest)) throw adapterFailure('unsupported');
            const current: ActiveRun = {
              id: `r${++runCounter}`,
              request,
              seen: new Set(),
              leases: new Set(),
              streaming: agent.stream === true,
              events: [],
              position,
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
                  if (store === undefined) lost.add(request.sessionId);
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
              } catch {}
            };
            request.signal.addEventListener('abort', cancel, { once: true });
            send({
              v: 1,
              kind: 'run',
              runId: current.id,
              request: runRequest,
            });
            if (request.signal.aborted) cancel();
            // Stream events leave in the order the page produced them, ahead of the outcome.
            let text: string | undefined;
            let wake = Promise.withResolvers<void>();
            current.wake = () => wake.resolve();
            void result.then((value) => {
              text = value;
              wake.resolve();
            });
            for (;;) {
              for (const event of current.events.splice(0))
                if (!request.signal.aborted) yield event;
              // Events queued while a yield was suspended still precede the outcome.
              if (current.events.length > 0) continue;
              if (text !== undefined) break;
              await wake.promise;
              wake = Promise.withResolvers<void>();
            }
            settled = true;
            const outcome = parseRunResult(text);
            // A record comes back exactly when the host asked to persist.
            if (outcome.ok && (outcome.record !== undefined) !== (store !== undefined))
              throw adapterFailure('invalid');
            // Once Go has finished, the record holds everything; only a disposed instance or a
            // cancelled run stops the commit.
            const open = !request.signal.aborted && !(store !== undefined && disposed);
            if (open) {
              const sessionId = request.sessionId;
              const commit = async (pending: string | undefined): Promise<void> => {
                if (store === undefined || !outcome.ok || outcome.record === undefined) return;
                const held = stored.get(sessionId);
                const key = held?.key ?? newKey();
                const revision = await saveConversation(
                  store,
                  sessionId,
                  held?.revision ?? 0,
                  key,
                  outcome.record,
                  current.position,
                  pending,
                );
                const pause =
                  outcome.paused === undefined
                    ? undefined
                    : ({
                        interactionId: outcome.paused.interactionId as InteractionId,
                        ...outcome.paused.request,
                      } as PendingInteraction);
                stored.set(sessionId, {
                  record: outcome.record,
                  ...(pause === undefined ? {} : { pause }),
                  position: current.position,
                  conversation,
                  key,
                  revision,
                });
                committed = true;
              };
              if (outcome.ok && outcome.paused !== undefined) {
                const interaction: PendingInteraction = {
                  interactionId: outcome.paused.interactionId as InteractionId,
                  ...outcome.paused.request,
                };
                // A Worker that died after Go finished took the paused session with it, unless the
                // record carries it.
                if (dead && store === undefined) throw adapterFailure('unavailable');
                if (current.streaming) emitPaused(current);
                await commit(interaction.interactionId);
                pauses.set(request.sessionId, { interaction, position: current.position });
                committed = true;
                if (!request.signal.aborted && !(store !== undefined && disposed)) {
                  if (current.streaming) for (const event of current.events.splice(0)) yield event;
                  yield { type: 'interaction', interaction };
                }
              } else if (outcome.ok) {
                await commit(undefined);
                if (!request.signal.aborted && !(store !== undefined && disposed))
                  yield { type: 'output', output: outcome.output };
              } else {
                yield { type: 'error', error: toErrorInfo(errorCodeOf(outcome.code)) };
              }
            }
          } catch (error) {
            if (!request.signal.aborted)
              yield { type: 'error', error: toErrorInfo(failureCode(error, 'executor_error')) };
          } finally {
            if (store !== undefined && !committed && consumed !== undefined && !disposed)
              pauses.set(request.sessionId, consumed);
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
        pending: async (sessionId, options) => {
          await hydrate(sessionId, options?.registerRestoredData);
          return pauses.get(sessionId)?.interaction;
        },
        dispose: async () => {
          disposed = true;
          stored.clear();
          known.clear();
          loading.clear();
          teardown();
          markDead();
        },
      };
    },
  };
}
