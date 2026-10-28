// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type Context, context, type Tracer } from '@opentelemetry/api';
import type { AgentDefinition } from './definition.js';
import {
  type ErrorInfo,
  GalaxieError,
  isErrorCode,
  isGalaxieError,
  toErrorInfo,
} from './errors.js';
import type { ExecutorEvent } from './events.js';
import type { ExecutorAdapter, ExecutorAgent } from './executor.js';
import type { InstanceId, RunId, SessionId } from './ids.js';
import type { AgentInstance, AgentSnapshot, RunSnapshot } from './instance.js';
import type { PendingInteraction } from './interactions.js';
import type { InstanceState, RunStatus } from './lifecycle.js';
import { RunEvents } from './run-events.js';
import type { CreateOptions, DiagnosticEvent } from './runtime.js';
import { type RunInstrumentation, startRunTrace } from './tracing.js';

const SETTLE_TIMEOUT_MS = 10_000;

interface RunRecord {
  readonly runId: RunId;
  readonly controller: AbortController;
  readonly events: RunEvents;
  readonly settle: () => void;
  status: RunStatus;
  pending?: PendingInteraction;
  error?: ErrorInfo;
  tracing?: RunInstrumentation;
}

function terminal(run: RunRecord): boolean {
  return run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled';
}

function hasOutcome(run: RunRecord): boolean {
  return terminal(run) || run.status === 'waiting_input';
}

function waitForSettlement(settled: Promise<void>, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (completed: boolean): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      resolve(completed);
    };
    const aborted = (): void => finish(false);
    const timer = setTimeout(() => finish(false), SETTLE_TIMEOUT_MS);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) finish(false);
    void settled.then(() => finish(true));
  });
}

export function createAgentInstance(
  definition: AgentDefinition,
  adapter: ExecutorAdapter<unknown, unknown>,
  options: CreateOptions,
  instrumentation: { readonly appId: string; readonly tracer: Tracer },
  onDisposed: () => void,
  diagnostics?: (event: DiagnosticEvent) => void,
): AgentInstance<unknown, unknown> {
  const instanceId = globalThis.crypto.randomUUID() as InstanceId;
  const sessionId = globalThis.crypto.randomUUID() as SessionId;
  let state: InstanceState = 'created';
  let prepareError: ErrorInfo | undefined;
  let snapshot: AgentSnapshot<unknown> = Object.freeze({ instanceId, state });
  const listeners = new Set<() => void>();
  let executor: ExecutorAgent | undefined;
  let preparation: Promise<void> | undefined;
  let prepareController: AbortController | undefined;
  let rejectPreparation: ((error: unknown) => void) | undefined;
  let disposal: Promise<void> | undefined;
  let executorDisposal: Promise<void> | undefined;
  let disposing = false;
  let claimingSlot = false;
  let current: RunRecord | undefined;
  let settlement: Promise<void> = Promise.resolve();

  const report = (event: Omit<DiagnosticEvent, 'instanceId'>): void => {
    try {
      diagnostics?.({ ...event, instanceId });
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  };
  const assertUsable = (): void => {
    if (disposing) throw new GalaxieError('invalid', 'The instance was disposed.');
  };
  const publish = (events?: RunEvents, afterSnapshot?: () => void): void => {
    const run: RunSnapshot | undefined =
      current === undefined
        ? undefined
        : Object.freeze({
            runId: current.runId,
            status: current.status,
            labels: Object.freeze([]),
            ...(current.pending === undefined ? {} : { pending: current.pending }),
            ...(current.error === undefined ? {} : { error: current.error }),
          });
    snapshot = Object.freeze({
      instanceId,
      state,
      ...(prepareError === undefined ? {} : { prepareError }),
      ...(run === undefined ? {} : { run }),
    });
    // AbortSignal callbacks run synchronously and must observe the committed snapshot too.
    afterSnapshot?.();
    events?.notify();
    if (state === 'disposed') {
      listeners.clear();
      return;
    }
    for (const listener of [...listeners]) {
      if (snapshot.state === 'disposed') break;
      if (!listeners.has(listener)) continue;
      try {
        listener();
      } catch (error) {
        report({ kind: 'listener_threw', error });
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };
  const disposeExecutor = (): Promise<void> => {
    if (executorDisposal === undefined) {
      const owned = executor;
      executorDisposal = Promise.resolve().then(async () => {
        try {
          await owned?.dispose();
        } catch (error) {
          report({ kind: 'executor_dispose_failed', error });
        }
      });
    }
    return executorDisposal;
  };
  const cancelRun = (run: RunRecord): void => {
    run.status = 'cancelled';
    delete run.pending;
    run.events.append({ type: 'cancelled' });
    run.tracing?.finish('cancelled');
  };
  const failRun = (run: RunRecord, error: ErrorInfo): void => {
    run.status = 'failed';
    run.error = Object.freeze(error);
    delete run.pending;
    run.events.append({ type: 'error', error: run.error });
    publish(run.events);
  };
  const acceptEvent = (run: RunRecord, event: ExecutorEvent): void => {
    if (terminal(run)) {
      report({ kind: 'late_event', runId: run.runId, error: event });
      return;
    }
    switch (event.type) {
      case 'output':
        run.status = 'succeeded';
        delete run.pending;
        break;
      case 'error': {
        const knownCode = isErrorCode(event.error.code);
        const error = Object.freeze(
          toErrorInfo(
            knownCode ? event.error.code : 'executor_error',
            event.error.type === undefined ? undefined : { name: event.error.type },
          ),
        );
        failRun(run, error);
        if (!knownCode)
          report({ kind: 'protocol_violation', runId: run.runId, error: event.error });
        report({
          kind: 'run_failed',
          runId: run.runId,
          error:
            isGalaxieError(event.error) && event.error.cause !== undefined
              ? event.error.cause
              : event.error,
        });
        return;
      }
      case 'interaction':
        run.status = 'waiting_input';
        run.pending = event.interaction;
        break;
      case 'stream':
        break;
    }
    run.events.append(event);
    publish(run.events);
  };
  const execute = async (
    run: RunRecord,
    predecessor: Promise<void>,
    input: unknown,
    parent: Context,
  ): Promise<void> => {
    try {
      const ready = await waitForSettlement(predecessor, run.controller.signal);
      if (terminal(run)) return;
      if (!ready) {
        failRun(run, toErrorInfo('timeout'));
        return;
      }
      const agent = executor;
      if (agent === undefined) throw new Error('The prepared executor is unavailable.');
      run.status = 'running';
      publish();
      // A synchronous listener may cancel or dispose before the executor is entered.
      if (terminal(run)) return;
      run.tracing = startRunTrace(instrumentation.tracer, parent, {
        appId: instrumentation.appId,
        agentId: definition.id,
        agentVersion: definition.version,
        instanceId,
        sessionId,
        runId: run.runId,
        executorId: adapter.id,
        executorVersion: adapter.version,
      });
      const iterator = agent
        .run({
          runId: run.runId,
          sessionId,
          command: { type: 'start', input },
          signal: run.controller.signal,
          trace: run.tracing.recorder,
          limits: { steps: 25 },
          capabilities: {
            call: async () => {
              throw new GalaxieError('denied', 'Policy denied the request.');
            },
          },
        })
        [Symbol.asyncIterator]();
      // Never use for-await here: its early exit calls return() and can hide live engine work.
      while (true) {
        const result = await iterator.next();
        if (result.done) break;
        acceptEvent(run, result.value);
      }
      if (!hasOutcome(run)) {
        const error = { name: 'ProtocolViolation' };
        failRun(run, toErrorInfo('executor_error', error));
        report({ kind: 'protocol_violation', runId: run.runId, error });
      }
    } catch (error) {
      if (!terminal(run)) {
        failRun(run, toErrorInfo('executor_error', error));
        report({ kind: 'run_failed', runId: run.runId, error });
      } else {
        report({ kind: 'late_event', runId: run.runId, error });
      }
    } finally {
      run.tracing?.finish(run.status, run.error);
      run.settle();
    }
  };

  return {
    instanceId,
    getSnapshot: () => snapshot,
    subscribe(listener): () => void {
      if (state !== 'disposed') listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prepare(): Promise<void> {
      try {
        assertUsable();
      } catch (error) {
        return Promise.reject(error);
      }
      if (state === 'ready') return Promise.resolve();
      if (preparation !== undefined) return preparation;
      const controller = new AbortController();
      prepareController = controller;
      const { promise, resolve: resolvePreparation, reject } = Promise.withResolvers<void>();
      rejectPreparation = reject;
      preparation = promise;
      prepareError = undefined;
      state = 'preparing';
      publish();
      void Promise.resolve()
        .then(() => adapter.prepare(options.agent, options.services, { signal: controller.signal }))
        .then(
          async (agent) => {
            executor = agent;
            if (disposing) {
              // Disposal need not wait for a download that ignores its abort signal.
              executorDisposal = undefined;
              await disposeExecutor();
              return;
            }
            preparation = undefined;
            rejectPreparation = undefined;
            prepareController = undefined;
            state = 'ready';
            publish();
            resolvePreparation();
          },
          (error: unknown) => {
            report({ kind: 'prepare_failed', error });
            if (disposing) return;
            const reject = rejectPreparation;
            preparation = undefined;
            rejectPreparation = undefined;
            prepareController = undefined;
            const info = Object.freeze(
              toErrorInfo(isGalaxieError(error) ? error.code : 'executor_error', error),
            );
            prepareError = info;
            state = 'created';
            publish();
            reject?.(new GalaxieError(info.code, info.message));
          },
        );
      return promise;
    },
    start(input): Promise<{ readonly runId: RunId }> {
      try {
        assertUsable();
        if (state !== 'ready' || claimingSlot || (current !== undefined && !terminal(current))) {
          throw new GalaxieError('invalid', 'The instance has no available run slot.');
        }
      } catch (error) {
        return Promise.reject(error);
      }
      claimingSlot = true;
      const parent = context.active();
      return (async () => {
        let value: unknown;
        try {
          const result = await definition.input['~standard'].validate(input);
          if (result.issues !== undefined) throw result.issues;
          value = result.value;
        } catch {
          claimingSlot = false;
          assertUsable();
          throw new GalaxieError('invalid', 'The run input failed validation.');
        }
        try {
          assertUsable();
        } catch (error) {
          claimingSlot = false;
          throw error;
        }
        const runId = globalThis.crypto.randomUUID() as RunId;
        const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
        const run: RunRecord = {
          runId,
          controller: new AbortController(),
          events: new RunEvents(runId),
          settle,
          status: 'queued',
        };
        const predecessor = settlement;
        settlement = Promise.all([predecessor, settled]).then(() => {});
        current = run;
        claimingSlot = false;
        publish();
        void execute(run, predecessor, value, parent);
        return { runId };
      })();
    },
    async dispatch() {
      assertUsable();
      throw new GalaxieError('unsupported', 'Interaction dispatch is not implemented.');
    },
    async cancel(runId) {
      assertUsable();
      if (current?.runId !== runId)
        throw new GalaxieError('stale', 'The run is no longer current.');
      const run = current;
      if (!terminal(run)) {
        cancelRun(run);
        publish(run.events, () => run.controller.abort());
      }
      return { runId, status: run.status };
    },
    events(runId) {
      const run = current;
      const events = run?.events ?? new RunEvents(runId);
      return events.iterate(() => {
        assertUsable();
        if (run?.runId !== runId || current !== run) {
          throw new GalaxieError('stale', 'The run is no longer current.');
        }
      });
    },
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal;
      disposing = true;
      const { promise, resolve: resolveDisposal } = Promise.withResolvers<void>();
      disposal = promise;
      state = 'disposing';
      rejectPreparation?.(new GalaxieError('cancelled', 'Preparation was cancelled.'));
      const run = current;
      const cancelledRun = run !== undefined && !terminal(run) ? run : undefined;
      if (cancelledRun !== undefined) cancelRun(cancelledRun);
      publish(run?.events, () => {
        prepareController?.abort();
        cancelledRun?.controller.abort();
      });
      void (async () => {
        await waitForSettlement(settlement);
        await disposeExecutor();
        state = 'disposed';
        publish();
        onDisposed();
        resolveDisposal();
      })();
      return disposal;
    },
  };
}
