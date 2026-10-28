// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type Context, context, type Tracer } from '@opentelemetry/api';
import { deadlineTimer, RunBudget } from './budgets.js';
import { CapabilityBroker, registerPrivate } from './capability-broker.js';
import type { AgentDefinition } from './definition.js';
import {
  type ErrorCode,
  type ErrorInfo,
  GalaxieError,
  isErrorCode,
  isGalaxieError,
  toErrorInfo,
} from './errors.js';
import type { ExecutorEvent } from './events.js';
import type { ExecutorAdapter, ExecutorAgent, RunCommand } from './executor.js';
import type { InstanceId, InteractionId, RunId, SessionId } from './ids.js';
import type { AgentInstance, AgentSnapshot, RunSnapshot } from './instance.js';
import type {
  DispatchReceipt,
  InboxStatus,
  PendingInteraction,
  Submission,
} from './interactions.js';
import type { InstanceState, RunStatus } from './lifecycle.js';
import { ModelRouter } from './model-router.js';
import type { SelectedModelRoute } from './models.js';
import type { BudgetLimits, DataLabel, DestinationAllowlist } from './policy.js';
import { RunEvents } from './run-events.js';
import type { CreateOptions, DiagnosticEvent } from './runtime.js';
import { type RunInstrumentation, startRunTrace } from './tracing.js';

const SETTLE_TIMEOUT_MS = 10_000;

interface RunRecord {
  readonly runId: RunId;
  readonly controller: AbortController;
  readonly capabilityController: AbortController;
  readonly labels: Set<DataLabel>;
  readonly privateValues: Set<string>;
  readonly grants: ReadonlySet<string>;
  readonly budget: RunBudget;
  readonly inbox: Map<InteractionId, InboxEntry>;
  dispatching?: InteractionId;
  segment?: SegmentRecord;
  readonly events: RunEvents;
  status: RunStatus;
  pending?: PendingInteraction;
  error?: ErrorInfo;
}

interface InboxEntry extends Submission {
  readonly interactionId: InteractionId;
  status: InboxStatus;
}

interface SegmentRecord {
  readonly index: number;
  readonly settle: () => void;
  readonly submission?: InboxEntry;
  outcome?: RunStatus;
  clearWallClock?: () => void;
  tracing?: RunInstrumentation;
}

function terminal(run: RunRecord): boolean {
  return run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled';
}

function active(run: RunRecord, segment: SegmentRecord): boolean {
  return !terminal(run) && segment.outcome === undefined;
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
  instrumentation: {
    readonly appId: string;
    readonly tracer: Tracer;
    readonly limits: BudgetLimits;
    readonly policy: Readonly<Record<DataLabel, DestinationAllowlist>>;
  },
  onDisposed: () => void,
  diagnostics?: (event: DiagnosticEvent) => void,
): AgentInstance<unknown, unknown> {
  const instanceId = globalThis.crypto.randomUUID() as InstanceId;
  const sessionId = globalThis.crypto.randomUUID() as SessionId;
  let state: InstanceState = 'created';
  let prepareError: ErrorInfo | undefined;
  let snapshot: AgentSnapshot<unknown> = Object.freeze({ instanceId, state });
  const listeners = new Set<() => void>();
  const routes = new Map<string, SelectedModelRoute>();
  let publishedRoutes: Readonly<Record<string, SelectedModelRoute>> | undefined;
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
  const dispatchChecks = new Set<Promise<DispatchReceipt>>();

  const report = (event: Omit<DiagnosticEvent, 'instanceId'>): void => {
    try {
      diagnostics?.({ ...event, instanceId });
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  };
  const broker = new CapabilityBroker(
    definition,
    options.bindings,
    instrumentation.policy,
    options.principalScope,
    report,
  );
  const router = new ModelRouter(definition, options.models, instrumentation.policy, report);
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
            labels: Object.freeze([...current.labels].sort()),
            ...(current.pending === undefined ? {} : { pending: current.pending }),
            ...(current.segment?.submission === undefined
              ? {}
              : {
                  submission: Object.freeze({
                    interactionId: current.segment.submission.interactionId,
                    status: current.segment.submission.status,
                  }),
                }),
            ...(current.error === undefined ? {} : { error: current.error }),
          });
    snapshot = Object.freeze({
      instanceId,
      state,
      ...(prepareError === undefined ? {} : { prepareError }),
      ...(run === undefined ? {} : { run }),
      ...(publishedRoutes === undefined ? {} : { routes: publishedRoutes }),
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
    const segment = run.segment;
    if (segment !== undefined && segment.outcome === undefined) {
      segment.outcome = 'cancelled';
      segment.clearWallClock?.();
      segment.tracing?.setLabels([...run.labels]);
      segment.tracing?.finish('cancelled');
    }
    run.privateValues.clear();
  };
  const failRun = (run: RunRecord, error: ErrorInfo): void => {
    if (run.segment !== undefined) {
      run.segment.outcome = 'failed';
      run.segment.clearWallClock?.();
    }
    run.status = 'failed';
    run.error = Object.freeze(error);
    delete run.pending;
    run.events.append({ type: 'error', error: run.error });
    run.privateValues.clear();
    publish(run.events, () => run.capabilityController.abort());
  };
  const failRunForBudget = (
    run: RunRecord,
    segment: SegmentRecord,
    name: keyof BudgetLimits,
    error: ErrorInfo = toErrorInfo('budget_exceeded'),
  ): void => {
    if (!active(run, segment)) return;
    segment.tracing?.recordBudget(name);
    failRun(run, error);
    run.controller.abort();
    segment.tracing?.setLabels([...run.labels]);
    segment.tracing?.finish('failed', run.error);
  };
  const acceptEvent = (run: RunRecord, segment: SegmentRecord, event: ExecutorEvent): void => {
    if (!active(run, segment)) {
      report({ kind: 'late_event', runId: run.runId });
      return;
    }
    if (event.type !== 'stream' && segment.submission !== undefined)
      segment.submission.status = 'consumed';
    switch (event.type) {
      case 'output':
        segment.outcome = 'succeeded';
        segment.clearWallClock?.();
        run.status = 'succeeded';
        run.privateValues.clear();
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
        if (error.code === 'budget_exceeded') failRunForBudget(run, segment, 'steps', error);
        else failRun(run, error);
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
        if (run.inbox.has(event.interaction.interactionId)) {
          // An answered interaction can never pause again: dispatch would only report duplicate.
          const error = { name: 'ProtocolViolation' };
          failRun(run, toErrorInfo('unsupported', error));
          report({ kind: 'protocol_violation', runId: run.runId, error });
          return;
        }
        segment.outcome = 'waiting_input';
        segment.clearWallClock?.();
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
    segment: SegmentRecord,
    predecessor: Promise<void>,
    command: RunCommand,
    parent: Context,
  ): Promise<void> => {
    let entered = false;
    try {
      const ready = await waitForSettlement(predecessor, run.controller.signal);
      if (!active(run, segment)) return;
      if (!ready) {
        failRun(run, toErrorInfo('timeout'));
        return;
      }
      const agent = executor;
      if (agent === undefined) throw new Error('The prepared executor is unavailable.');
      run.status = 'running';
      segment.clearWallClock = deadlineTimer(instrumentation.limits.wallClockMs, () =>
        failRunForBudget(run, segment, 'wallClockMs'),
      );
      publish();
      // A synchronous listener may cancel or dispose before the executor is entered.
      if (!active(run, segment)) return;
      segment.tracing = startRunTrace(instrumentation.tracer, parent, {
        appId: instrumentation.appId,
        agentId: definition.id,
        agentVersion: definition.version,
        instanceId,
        sessionId,
        runId: run.runId,
        segment: segment.index,
        executorId: adapter.id,
        executorVersion: adapter.version,
      });
      const ports = {
        runId: run.runId,
        signal: AbortSignal.any([run.controller.signal, run.capabilityController.signal]),
        labels: run.labels,
        privateValues: run.privateValues,
        grants: run.grants,
        budget: run.budget,
        tracing: segment.tracing,
        active: () => active(run, segment),
        labelsChanged: () => {
          if (active(run, segment)) {
            segment.tracing?.setLabels([...run.labels]);
            publish();
          }
        },
        failBudget: (name: keyof BudgetLimits) => failRunForBudget(run, segment, name),
        selectedRouteChanged: (role: string, selected: SelectedModelRoute) => {
          if (!active(run, segment)) return;
          const previous = routes.get(role);
          if (
            previous?.providerId === selected.providerId &&
            previous.destination === selected.destination
          )
            return;
          routes.set(role, selected);
          publishedRoutes = Object.freeze(Object.fromEntries(routes));
          publish();
        },
      };
      entered = true;
      const iterator = agent
        .run({
          runId: run.runId,
          sessionId,
          command,
          signal: run.controller.signal,
          trace: segment.tracing.recorder,
          limits: { steps: instrumentation.limits.steps },
          capabilities: broker.port(ports),
          models: router.port(ports),
        })
        [Symbol.asyncIterator]();
      // Never use for-await here: its early exit calls return() and can hide live engine work.
      while (true) {
        const result = await iterator.next();
        if (result.done) break;
        acceptEvent(run, segment, result.value);
      }
      if (active(run, segment)) {
        const error = { name: 'ProtocolViolation' };
        if (segment.submission !== undefined) segment.submission.status = 'consumed';
        failRun(run, toErrorInfo('executor_error', error));
        report({ kind: 'protocol_violation', runId: run.runId, error });
      }
    } catch (error) {
      if (active(run, segment)) {
        if (entered && segment.submission !== undefined) segment.submission.status = 'consumed';
        failRun(run, toErrorInfo('executor_error', error));
        report({ kind: 'run_failed', runId: run.runId, error });
      } else {
        report({ kind: 'late_event', runId: run.runId });
      }
    } finally {
      segment.clearWallClock?.();
      if (terminal(run)) run.privateValues.clear();
      segment.tracing?.setLabels([...run.labels]);
      segment.tracing?.finish(segment.outcome ?? run.status, run.error);
      segment.settle();
    }
  };

  const startSegment = (run: RunRecord, command: RunCommand, parent: Context): void => {
    const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
    const submission = command.type === 'resume' ? run.inbox.get(command.interactionId) : undefined;
    const segment: SegmentRecord = {
      index: (run.segment?.index ?? -1) + 1,
      settle,
      ...(submission === undefined ? {} : { submission }),
    };
    const predecessor = settlement;
    settlement = Promise.all([predecessor, settled]).then(() => {});
    run.segment = segment;
    void execute(run, segment, predecessor, command, parent);
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
        .then(() =>
          adapter.prepare(options.agent, options.services, {
            signal: controller.signal,
            models: router.summary,
          }),
        )
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
    start(input, startOptions): Promise<{ readonly runId: RunId }> {
      let grants: ReadonlySet<string>;
      try {
        assertUsable();
        grants = broker.validateGrants(startOptions?.grants);
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
        const run: RunRecord = {
          runId,
          controller: new AbortController(),
          capabilityController: new AbortController(),
          labels: new Set(broker.input.labels),
          privateValues: new Set(),
          grants,
          events: new RunEvents(runId),
          budget: new RunBudget(instrumentation.limits),
          inbox: new Map(),
          status: 'queued',
        };
        registerPrivate(broker.input.privateStrings(value), run.privateValues);
        current = run;
        claimingSlot = false;
        publish();
        startSegment(run, { type: 'start', input: value }, parent);
        return { runId };
      })();
    },
    dispatch(event): Promise<DispatchReceipt> {
      try {
        assertUsable();
      } catch (error) {
        return Promise.reject(error);
      }
      const rejected = (code: ErrorCode): DispatchReceipt => ({
        status: 'rejected',
        error: toErrorInfo(code),
      });
      const run = current;
      if (event.instanceId !== instanceId || run === undefined || event.runId !== run.runId)
        return Promise.resolve(rejected('stale'));
      const interactionId = event.interactionId;
      if (run.inbox.has(interactionId) || run.dispatching === interactionId)
        return Promise.resolve(rejected('duplicate'));
      const pending = run.pending;
      if (
        run.status !== 'waiting_input' ||
        pending === undefined ||
        interactionId !== pending.interactionId ||
        event.surfaceId !== pending.surfaceId ||
        event.viewRevision !== pending.viewRevision
      )
        return Promise.resolve(rejected('stale'));
      if (!adapter.features.resume) return Promise.resolve(rejected('unsupported'));
      const action = event.action;
      if (typeof action !== 'string' || action.length === 0)
        return Promise.resolve(rejected('invalid'));
      let payload: unknown;
      try {
        payload = JSON.parse(run.budget.payload(event.payload));
      } catch (error) {
        return Promise.resolve(rejected(isGalaxieError(error) ? error.code : 'invalid'));
      }
      const parent = context.active();
      run.dispatching = interactionId;
      const checking = (async (): Promise<DispatchReceipt> => {
        try {
          const committed = await executor?.pending(sessionId);
          if (
            disposing ||
            current !== run ||
            run.status !== 'waiting_input' ||
            committed?.interactionId !== interactionId
          )
            return rejected('stale');
          const entry: InboxEntry = { interactionId, action, payload, status: 'accepted' };
          run.inbox.set(interactionId, entry);
          run.status = 'running';
          delete run.pending;
          // Register settlement before publishing: a listener may dispose synchronously.
          startSegment(run, { type: 'resume', interactionId, action, payload }, parent);
          publish();
          return { status: 'accepted', interactionId };
        } catch (error) {
          report({ kind: 'dispatch_failed', runId: run.runId, error });
          return rejected('executor_error');
        } finally {
          delete run.dispatching;
        }
      })();
      dispatchChecks.add(checking);
      void checking.then(() => dispatchChecks.delete(checking));
      return checking;
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
        router.dispose();
      });
      void (async () => {
        await waitForSettlement(Promise.all([settlement, ...dispatchChecks]).then(() => {}));
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
