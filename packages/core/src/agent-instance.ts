// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ProtocolErrorCode } from '@galaxie/ui-protocol';
import { type Context, context, type Tracer } from '@opentelemetry/api';
import { type Annotations, readAnnotations } from './annotations.js';
import { deadlineTimer, RunBudget } from './budgets.js';
import { CapabilityBroker } from './capability-broker.js';
import { ConfirmationGate } from './confirmations.js';
import type { AgentDefinition } from './definition.js';
import type { DevelopmentWarning, DevelopmentWarningReporter } from './development.js';
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
import {
  checkInteractionBindings,
  checkInteractionUrlPolicy,
  isAllowedUrl,
} from './interactions.js';
import type { InstanceState, RunStatus } from './lifecycle.js';
import { ModelRouter } from './model-router.js';
import type { OutputSafetyHook, PublishedModelRoute, SelectedModelRoute } from './models.js';
import type { BudgetLimits, DataLabel, DestinationAllowlist, DestinationClass } from './policy.js';
import { registerPrivate } from './private-values.js';
import { copyRecoveryJson, validateSession, validateSubmissions } from './recovery.js';
import { RunEvents } from './run-events.js';
import type { CreateOptions, DiagnosticEvent } from './runtime.js';
import { type StandardSchema, validateSync } from './schema.js';
import {
  checkSurfaceUrls,
  copySurfaceJson,
  createSurfacePolicy,
  parseSurfaceRecord,
  pendingFromSurface,
  protocolCategory,
  surfaceComponentId,
  surfaceModelChanges,
  surfaceViewRevision,
} from './surfaces.js';
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
  readonly renderOutcomes: Map<string, 'rendered' | 'failed'>;
  readonly surfaceRevisions: Map<string, number>;
  submittedText?: boolean;
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

function* payloadStrings(value: unknown): Generator<string, void> {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string' && current.length > 0) yield current;
    if (typeof current === 'object' && current !== null)
      for (const child of Object.values(current)) pending.push(child);
  }
}

function containsText(value: unknown): boolean {
  return payloadStrings(value).next().done !== true;
}

function invalidated(error: unknown): boolean {
  const marked = (value: unknown): boolean =>
    typeof value === 'object' &&
    value !== null &&
    Object.getOwnPropertyDescriptor(value, 'invalidated')?.value === true;
  return marked(error) || (isGalaxieError(error) && marked(error.cause));
}

function failureCode(error: unknown, fallback: ErrorCode): ErrorCode {
  const marked = (value: unknown, code: 'fenced' | 'unrecoverable'): boolean =>
    typeof value === 'object' &&
    value !== null &&
    Object.getOwnPropertyDescriptor(value, code)?.value === true;
  if (invalidated(error) || (isGalaxieError(error) && error.code === 'stale')) return 'stale';
  for (const code of ['fenced', 'unrecoverable'] as const) {
    if (
      marked(error, code) ||
      (isGalaxieError(error) && (error.code === code || marked(error.cause, code)))
    )
      return code;
  }
  return fallback;
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
    readonly urlAllowlist: readonly string[];
    readonly surfacePolicy?: ReturnType<typeof createSurfacePolicy>;
    readonly outputSafety?: OutputSafetyHook;
    readonly developmentWarnings?: DevelopmentWarningReporter;
    readonly developmentTraceText?: {
      readonly destination: DestinationClass;
    };
  },
  onDisposed: () => void,
  diagnostics?: (event: DiagnosticEvent) => void,
): {
  readonly instance: AgentInstance<unknown, unknown>;
  readonly checkDevelopmentWarnings?: () => Promise<void>;
} {
  const instanceId = globalThis.crypto.randomUUID() as InstanceId;
  const sessionId = options.sessionId ?? (globalThis.crypto.randomUUID() as SessionId);
  let state: InstanceState = 'created';
  let prepareError: ErrorInfo | undefined;
  let snapshot: AgentSnapshot<unknown> = Object.freeze({ instanceId, state });
  const listeners = new Set<() => void>();
  const routes = new Map<string, PublishedModelRoute>();
  let publishedRoutes: Readonly<Record<string, PublishedModelRoute>> | undefined;
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
  const checkpointChecks = new Set<Promise<unknown>>();
  const payloadAnnotations = new WeakMap<StandardSchema, Annotations | null>();
  const surfacePolicy = instrumentation.surfacePolicy ?? createSurfacePolicy();
  const labelPayload = (run: RunRecord, schema: StandardSchema, payload: unknown): void => {
    let annotations = payloadAnnotations.get(schema);
    if (annotations === undefined) {
      try {
        annotations = readAnnotations(schema);
      } catch {
        annotations = null;
      }
      payloadAnnotations.set(schema, annotations);
    }
    if (annotations === null) {
      const values = [...payloadStrings(payload)];
      if (values.length > 0) run.labels.add('private-user');
      registerPrivate(values, run.privateValues);
    } else {
      for (const label of annotations.labels) run.labels.add(label);
      registerPrivate(annotations.privateStrings(payload), run.privateValues);
    }
  };

  const report = (event: Omit<DiagnosticEvent, 'instanceId'>): void => {
    try {
      diagnostics?.({ ...event, instanceId });
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  };
  const warn =
    instrumentation.developmentWarnings === undefined
      ? undefined
      : (warning: Omit<DevelopmentWarning, 'instanceId'>): void => {
          instrumentation.developmentWarnings?.({ ...warning, instanceId }, (error) =>
            report({ kind: 'listener_threw', error }),
          );
        };
  const confirmations =
    options.confirmations === undefined
      ? undefined
      : new ConfirmationGate(
          options.confirmations,
          options.principalScope,
          () => publish(),
          report,
        );
  const broker = new CapabilityBroker(
    definition,
    options.bindings,
    instrumentation.policy,
    options.principalScope,
    report,
    confirmations,
  );
  const router = new ModelRouter(
    definition,
    options.models,
    instrumentation.policy,
    report,
    instrumentation.outputSafety,
  );
  if (options.models !== undefined && instrumentation.outputSafety === undefined)
    report({ kind: 'output_safety_unset' });
  const assertUsable = (): void => {
    if (disposing) throw new GalaxieError('invalid', 'The instance was disposed.');
  };
  const publish = (events?: RunEvents, afterSnapshot?: () => void): void => {
    if (current !== undefined && terminal(current)) confirmations?.endRun(current.runId, disposing);
    const pendingConfirmations = confirmations?.pending;
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
      ...(pendingConfirmations === undefined ? {} : { confirmations: pendingConfirmations }),
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
  // Raw stream events remain untrusted engine output and must never be rendered as UI.
  const interactionError = (
    interaction: PendingInteraction,
    privateValues: ReadonlySet<string>,
    revisions?: ReadonlyMap<string, number>,
  ):
    | {
        readonly reason: 'url' | 'binding';
        readonly error: ErrorInfo;
        readonly protocolCode?: ProtocolErrorCode;
      }
    | undefined => {
    if (interaction.surface !== undefined) {
      if (
        interaction.surface === null ||
        typeof interaction.surface !== 'object' ||
        Array.isArray(interaction.surface)
      )
        return { reason: 'binding', error: toErrorInfo('invalid') };
      const { viewRevision: _viewRevision, labels: _labels, ...raw } = interaction.surface;
      const record = parseSurfaceRecord(raw);
      if (record === undefined) return { reason: 'binding', error: toErrorInfo('invalid') };
      const catalog = options.ui?.catalogs?.[record.catalogId];
      if (
        catalog === undefined ||
        !Object.hasOwn(options.ui?.catalogs ?? {}, record.catalogId) ||
        !options.ui?.surfaces.includes(record.region as PendingInteraction['surfaceId'])
      )
        return { reason: 'binding', error: toErrorInfo('unsupported') };
      const result = surfacePolicy.validate(record, {
        binding: {
          region: record.region,
          a2uiSurfaceId: record.a2uiSurfaceId,
          catalogId: record.catalogId,
        },
        catalog,
        limits: {
          payloadBytes: instrumentation.limits.payloadBytes,
          components: instrumentation.limits.uiElements,
        },
        isAllowedUrl: (url) => isAllowedUrl(url, instrumentation.urlAllowlist),
      });
      if (!result.ok) {
        return {
          reason: result.code === 'URL_NOT_ALLOWED' ? 'url' : 'binding',
          error: toErrorInfo(protocolCategory(result.code)),
          protocolCode: result.code,
        };
      }
      if (
        record.status !== 'live' ||
        (revisions !== undefined &&
          record.revision !== (revisions.get(record.a2uiSurfaceId) ?? 0) + 1)
      )
        return { reason: 'binding', error: toErrorInfo('invalid') };
      if (
        !checkSurfaceUrls(
          record,
          instrumentation.urlAllowlist,
          instrumentation.policy['private-user'].allow.includes('third-party')
            ? undefined
            : privateValues,
        )
      )
        return {
          reason: 'url',
          error: toErrorInfo('denied'),
          protocolCode: checkSurfaceUrls(record, instrumentation.urlAllowlist)
            ? 'PRIVATE_VALUE_IN_URL'
            : 'URL_NOT_ALLOWED',
        };
      return undefined;
    }
    if (
      !checkInteractionUrlPolicy(
        interaction.props,
        instrumentation.urlAllowlist,
        instrumentation.policy['private-user'].allow.includes('third-party')
          ? undefined
          : privateValues,
      )
    )
      return { reason: 'url', error: toErrorInfo('denied') };
    if (options.ui !== undefined && !checkInteractionBindings(options.ui, interaction))
      return { reason: 'binding', error: toErrorInfo('unsupported') };
    return undefined;
  };
  const warnBlockedUrl = (interaction: PendingInteraction): void => {
    warn?.({
      code: 'url_blocked',
      ...(options.ui !== undefined && Object.hasOwn(options.ui.components, interaction.component)
        ? { name: interaction.component }
        : {}),
    });
  };
  const validateSubmission = (
    run: RunRecord,
    pending: PendingInteraction,
    action: string,
    raw: unknown,
  ): { readonly payload: unknown; readonly schema: StandardSchema | undefined } => {
    if (typeof action !== 'string' || action.length === 0)
      throw new GalaxieError('invalid', toErrorInfo('invalid').message);
    const actions = options.ui?.components[pending.component]?.actions;
    if (options.ui !== undefined && (actions === undefined || !Object.hasOwn(actions, action)))
      throw new GalaxieError('invalid', toErrorInfo('invalid').message);
    const payload: unknown = JSON.parse(run.budget.payload(raw));
    const schema = actions?.[action]?.payload;
    if (schema !== undefined && !validateSync(schema, payload).ok)
      throw new GalaxieError('invalid', toErrorInfo('invalid').message);
    return { payload, schema };
  };
  const validateSurfaceSubmission = (
    run: RunRecord,
    pending: PendingInteraction,
    action: string,
    raw: unknown,
    componentId?: string,
  ): ReturnType<typeof validateSubmission> => {
    const surface = pending.surface;
    if (surface !== undefined) {
      for (const [id, component] of Object.entries(surface.components)) {
        if (componentId !== undefined && id !== componentId) continue;
        const legacy = surfaceComponentId(surface.catalogId, component.component);
        if (!Object.hasOwn(options.ui?.components ?? {}, legacy)) continue;
        try {
          return validateSubmission(run, { ...pending, component: legacy }, action, raw);
        } catch (error) {
          if (isGalaxieError(error) && error.code === 'budget_exceeded') throw error;
        }
      }
    }
    throw new GalaxieError('invalid', toErrorInfo('invalid').message);
  };
  const withSurfaceLabels = (
    pending: PendingInteraction,
    labels: ReadonlySet<DataLabel>,
  ): PendingInteraction => {
    if (pending.surface === undefined) return pending;
    const { viewRevision: _viewRevision, labels: _labels, ...record } = pending.surface;
    const normalized = pendingFromSurface(pending.interactionId, record);
    const surface = normalized.surface;
    if (surface === undefined) return normalized;
    return Object.freeze({
      ...normalized,
      surface: Object.freeze({ ...surface, labels: Object.freeze([...labels].sort()) }),
    });
  };
  const acceptEvent = (
    run: RunRecord,
    segment: SegmentRecord,
    event: ExecutorEvent,
  ): void | Promise<void> => {
    if (!active(run, segment)) {
      report({ kind: 'late_event', runId: run.runId });
      return;
    }
    if (
      options.recovery === undefined &&
      event.type !== 'stream' &&
      segment.submission !== undefined
    )
      segment.submission.status = 'consumed';
    if (event.type === 'interaction') {
      if (!adapter.features.interrupts) {
        const error = { name: 'ProtocolViolation' };
        failRun(run, toErrorInfo('executor_error', error));
        report({ kind: 'protocol_violation', runId: run.runId, error });
        return;
      }
      if (run.inbox.has(event.interaction.interactionId)) {
        // An answered interaction can never pause again: dispatch would only report duplicate.
        const error = { name: 'ProtocolViolation' };
        failRun(run, toErrorInfo('unsupported', error));
        report({ kind: 'protocol_violation', runId: run.runId, error });
        return;
      }
      {
        const error = interactionError(event.interaction, run.privateValues, run.surfaceRevisions);
        if (error !== undefined) {
          failRun(run, error.error);
          report({
            kind: 'interaction_rejected',
            runId: run.runId,
            ...(error.protocolCode === undefined ? {} : { protocolCode: error.protocolCode }),
          });
          if (error.reason === 'url') warnBlockedUrl(event.interaction);
          return;
        }
      }
      if (event.interaction.surface !== undefined)
        event = { ...event, interaction: withSurfaceLabels(event.interaction, run.labels) };
    }
    const commit = (recheckSurface = false): void => {
      if (
        recheckSurface &&
        event.type === 'interaction' &&
        event.interaction.surface !== undefined
      ) {
        // Recovery writes can yield while another in-flight result registers private data.
        const error = interactionError(event.interaction, run.privateValues, run.surfaceRevisions);
        if (error !== undefined) {
          failRun(run, error.error);
          report({
            kind: 'interaction_rejected',
            runId: run.runId,
            ...(error.protocolCode === undefined ? {} : { protocolCode: error.protocolCode }),
          });
          if (error.reason === 'url') warnBlockedUrl(event.interaction);
          return;
        }
        event = { ...event, interaction: withSurfaceLabels(event.interaction, run.labels) };
      }
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
              failureCode(event.error, knownCode ? event.error.code : 'executor_error'),
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
          segment.outcome = 'waiting_input';
          segment.clearWallClock?.();
          run.status = 'waiting_input';
          run.pending = event.interaction;
          if (event.interaction.surface !== undefined)
            run.surfaceRevisions.set(
              event.interaction.surface.a2uiSurfaceId,
              event.interaction.surface.revision,
            );
          break;
        case 'stream':
          break;
      }
      run.events.append(event);
      publish(run.events);
    };
    const submission = segment.submission;
    const recovery = options.recovery;
    if (
      recovery !== undefined &&
      submission !== undefined &&
      (event.type === 'output' || event.type === 'interaction')
    ) {
      return (async () => {
        try {
          await recovery.consumeSubmission(sessionId, submission.interactionId);
          submission.status = 'consumed';
        } catch (error) {
          report({ kind: 'dispatch_failed', runId: run.runId, error });
        }
        if (active(run, segment)) commit(true);
      })();
    }
    commit();
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
      segment.tracing = startRunTrace(
        instrumentation.tracer,
        parent,
        {
          appId: instrumentation.appId,
          agentId: definition.id,
          agentVersion: definition.version,
          instanceId,
          sessionId,
          runId: run.runId,
          segment: segment.index,
          executorId: adapter.id,
          executorVersion: adapter.version,
        },
        {
          ...(instrumentation.developmentTraceText === undefined
            ? {}
            : { developmentTraceText: instrumentation.developmentTraceText }),
          policy: instrumentation.policy,
          labels: () =>
            run.submittedText ? new Set<DataLabel>([...run.labels, 'private-user']) : run.labels,
        },
      );
      const ports = {
        runId: run.runId,
        sessionId,
        segmentKey: command.type === 'resume' ? command.interactionId : 'start',
        effectOrdinals: new Map<string, number>(),
        ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
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
          routes.set(
            role,
            Object.freeze({
              ...selected,
              ...(previous !== undefined && previous.destination !== selected.destination
                ? { changedFrom: previous.destination }
                : {}),
            }),
          );
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
          registerRestoredData(value: unknown): void {
            if (!active(run, segment))
              throw new GalaxieError('stale', 'The run is no longer active.');
            const strings = [...payloadStrings(value)];
            if (strings.length === 0) return;
            run.labels.add('private-user');
            registerPrivate(strings, run.privateValues);
            ports.labelsChanged();
          },
        })
        [Symbol.asyncIterator]();
      // Never use for-await here: its early exit calls return() and can hide live engine work.
      while (true) {
        const result = await iterator.next();
        if (result.done) break;
        const accepting = acceptEvent(run, segment, result.value);
        if (accepting !== undefined) await accepting;
      }
      if (active(run, segment)) {
        const error = { name: 'ProtocolViolation' };
        if (options.recovery === undefined && segment.submission !== undefined)
          segment.submission.status = 'consumed';
        failRun(run, toErrorInfo('executor_error', error));
        report({ kind: 'protocol_violation', runId: run.runId, error });
      }
    } catch (error) {
      if (active(run, segment)) {
        if (options.recovery === undefined && entered && segment.submission !== undefined)
          segment.submission.status = 'consumed';
        failRun(run, toErrorInfo(failureCode(error, 'executor_error'), error));
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

  const instance: AgentInstance<unknown, unknown> = {
    instanceId,
    sessionId,
    getSnapshot: () => snapshot,
    respond: (id, decision) => confirmations?.respond(id, decision) ?? { status: 'stale' },
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
        if (options.sessionId !== undefined)
          throw new GalaxieError('invalid', 'An adopted session can only be restored.');
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
        if (options.recovery !== undefined) {
          try {
            assertUsable();
            const recording = options.recovery.recordSession(sessionId, {
              agentId: definition.id,
              agentVersion: definition.version,
              executorId: adapter.id,
            });
            checkpointChecks.add(recording);
            try {
              const stored = validateSession(await recording);
              if (
                stored?.agentId !== definition.id ||
                stored.agentVersion !== definition.version ||
                stored.executorId !== adapter.id
              )
                throw new GalaxieError('unavailable', toErrorInfo('unavailable').message);
            } finally {
              checkpointChecks.delete(recording);
            }
          } catch (error) {
            claimingSlot = false;
            assertUsable();
            const code = invalidated(error) ? 'stale' : 'unavailable';
            throw new GalaxieError(code, toErrorInfo(code).message);
          }
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
          renderOutcomes: new Map(),
          surfaceRevisions: new Map(),
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
    restore(restoreOptions): Promise<{ readonly runId: RunId } | undefined> {
      let grants: ReadonlySet<string>;
      try {
        assertUsable();
        grants = broker.validateGrants(restoreOptions?.grants);
        if (state !== 'ready' || claimingSlot || (current !== undefined && !terminal(current)))
          throw new GalaxieError('invalid', 'The instance has no available run slot.');
        if (
          !adapter.features.interrupts ||
          !adapter.features.resume ||
          !adapter.features.checkpoints
        )
          throw new GalaxieError('unsupported', 'This operation is unsupported.');
      } catch (error) {
        return Promise.reject(error);
      }
      claimingSlot = true;
      const parent = context.active();
      const restoring = (async () => {
        let restored: RunRecord;
        try {
          const recovery = options.recovery;
          if (recovery !== undefined) {
            let stored: ReturnType<typeof validateSession>;
            try {
              stored = validateSession(await recovery.session(sessionId));
            } catch (error) {
              if (disposing) assertUsable();
              report({ kind: 'restore_failed', error });
              const code = failureCode(error, 'unavailable');
              throw new GalaxieError(code, toErrorInfo(code).message);
            }
            assertUsable();
            if (stored !== undefined && stored.executorId !== adapter.id) {
              const error = new GalaxieError(
                'unsupported',
                'The saved session uses a different executor.',
              );
              report({ kind: 'restore_failed', error });
              throw error;
            }
            if (stored?.agentId !== definition.id || stored.agentVersion !== definition.version) {
              const error = new GalaxieError(
                'unsupported',
                'The saved session uses an unsupported agent version.',
              );
              report({ kind: 'restore_failed', error });
              throw error;
            }
          }
          const privateValues = new Set<string>();
          let pending: PendingInteraction | undefined;
          try {
            pending = await executor?.pending(sessionId, {
              registerRestoredData(value: unknown): void {
                registerPrivate(payloadStrings(value), privateValues);
              },
            });
          } catch (error) {
            report({ kind: 'restore_failed', error });
            const code = failureCode(error, 'executor_error');
            throw new GalaxieError(code, toErrorInfo(code).message);
          }
          assertUsable();
          const inbox = new Map<InteractionId, InboxEntry>();
          if (recovery !== undefined) {
            try {
              const submissions = validateSubmissions(await recovery.submissions(sessionId));
              assertUsable();
              for (const saved of submissions) {
                const entry: InboxEntry = { ...saved };
                if (entry.status === 'accepted' && entry.interactionId !== pending?.interactionId) {
                  await recovery.consumeSubmission(sessionId, entry.interactionId);
                  entry.status = 'consumed';
                  assertUsable();
                }
                inbox.set(entry.interactionId, entry);
              }
            } catch (error) {
              if (disposing) assertUsable();
              report({ kind: 'restore_failed', error });
              const code = failureCode(error, 'unavailable');
              throw new GalaxieError(code, toErrorInfo(code).message);
            }
          }
          assertUsable();
          if (pending === undefined) return undefined;
          if (
            pending.surface !== undefined &&
            pending.surface !== null &&
            typeof pending.surface === 'object'
          ) {
            const { viewRevision: _viewRevision, labels: _labels, ...raw } = pending.surface;
            const record = parseSurfaceRecord(raw);
            if (record !== undefined) registerPrivate(payloadStrings(record), privateValues);
          }
          for (const submission of inbox.values())
            registerPrivate(payloadStrings(submission.payload), privateValues);
          const error = interactionError(pending, privateValues);
          if (error !== undefined) {
            report({
              kind: 'interaction_rejected',
              ...(error.protocolCode === undefined ? {} : { protocolCode: error.protocolCode }),
            });
            if (error.reason === 'url') warnBlockedUrl(pending);
            throw new GalaxieError(error.error.code, error.error.message);
          }
          const runId = globalThis.crypto.randomUUID() as RunId;
          pending = withSurfaceLabels(
            pending,
            new Set<DataLabel>(['public', 'app', 'private-user']),
          );
          const run: RunRecord = {
            runId,
            controller: new AbortController(),
            capabilityController: new AbortController(),
            labels: new Set<DataLabel>(['public', 'app', 'private-user']),
            privateValues,
            submittedText: true,
            grants,
            events: new RunEvents(runId),
            budget: new RunBudget(instrumentation.limits),
            inbox,
            renderOutcomes: new Map(),
            surfaceRevisions: new Map(
              pending.surface === undefined
                ? []
                : [[pending.surface.a2uiSurfaceId, pending.surface.revision]],
            ),
            status: 'waiting_input',
            pending,
          };
          const submission = inbox.get(pending.interactionId);
          if (submission?.status === 'accepted') {
            let checked: ReturnType<typeof validateSubmission>;
            try {
              checked =
                pending.surface === undefined
                  ? validateSubmission(run, pending, submission.action, submission.payload)
                  : validateSurfaceSubmission(run, pending, submission.action, submission.payload);
            } catch (error) {
              const code = failureCode(error, isGalaxieError(error) ? error.code : 'invalid');
              throw new GalaxieError(code, toErrorInfo(code).message);
            }
            if (checked.schema !== undefined) labelPayload(run, checked.schema, checked.payload);
            run.status = 'running';
            delete run.pending;
            current = run;
            startSegment(
              run,
              {
                type: 'resume',
                interactionId: submission.interactionId,
                action: submission.action,
                payload: checked.payload,
              },
              parent,
            );
          } else {
            run.events.append({ type: 'interaction', interaction: pending });
            current = run;
          }
          restored = run;
        } finally {
          claimingSlot = false;
        }
        publish(restored.events);
        return { runId: restored.runId };
      })();
      checkpointChecks.add(restoring);
      void restoring.then(
        () => checkpointChecks.delete(restoring),
        () => checkpointChecks.delete(restoring),
      );
      return restoring;
    },
    recordRenderOutcome(outcome): void {
      const run = current;
      if (disposing || run === undefined || outcome.runId !== run.runId) return;
      const pending = run.pending;
      if (
        run.status !== 'waiting_input' ||
        pending === undefined ||
        outcome.interactionId !== pending.interactionId ||
        outcome.viewRevision !== pending.viewRevision
      )
        return;
      const key = JSON.stringify([outcome.interactionId, outcome.viewRevision]);
      const previous = run.renderOutcomes.get(key);
      if (previous === 'failed' || previous === outcome.status) return;
      run.renderOutcomes.set(key, outcome.status);
      const code = outcome.status === 'failed' ? outcome.code : undefined;
      run.segment?.tracing?.recordRender(outcome.status, code);
      run.events.append({
        type: 'render',
        interactionId: pending.interactionId,
        viewRevision: pending.viewRevision,
        status: outcome.status,
        ...(code === undefined ? {} : { code }),
      });
      run.events.notify();
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
      let checked: ReturnType<typeof validateSubmission>;
      let changes: ReturnType<typeof surfaceModelChanges>;
      let surfaceRevision: number | undefined;
      try {
        if (pending.surface === undefined) {
          if (event.surfaceAction !== undefined) return Promise.resolve(rejected('invalid'));
          checked = validateSubmission(run, pending, action, event.payload);
        } else {
          let submitted: unknown;
          try {
            submitted = copySurfaceJson(event.surfaceAction);
          } catch {
            return Promise.resolve(rejected('invalid'));
          }
          if (
            submitted === null ||
            typeof submitted !== 'object' ||
            Array.isArray(submitted) ||
            !('revision' in submitted) ||
            typeof submitted.revision !== 'number' ||
            !Number.isSafeInteger(submitted.revision) ||
            submitted.revision < 1 ||
            !('componentId' in submitted) ||
            typeof submitted.componentId !== 'string' ||
            submitted.componentId.length === 0 ||
            !('dataModel' in submitted)
          )
            return Promise.resolve(rejected('invalid'));
          surfaceRevision = submitted.revision;
          if (surfaceRevision !== pending.surface.revision)
            return Promise.resolve(rejected('stale'));
          checked = validateSurfaceSubmission(
            run,
            pending,
            action,
            event.payload,
            submitted.componentId,
          );
          run.budget.payload({ action, payload: checked.payload, surface: submitted });
          changes = surfaceModelChanges(
            pending.surface,
            submitted.dataModel,
            options.ui?.catalogs?.[pending.surface.catalogId],
          );
          if (changes === undefined) return Promise.resolve(rejected('invalid'));
        }
      } catch (error) {
        return Promise.resolve(
          rejected(failureCode(error, isGalaxieError(error) ? error.code : 'invalid')),
        );
      }
      const { payload, schema: payloadSchema } = checked;
      const parent = context.active();
      run.dispatching = interactionId;
      const checking = (async (): Promise<DispatchReceipt> => {
        try {
          const committed = await executor?.pending(sessionId, {
            registerRestoredData(value: unknown): void {
              registerPrivate(payloadStrings(value), run.privateValues);
            },
          });
          if (
            disposing ||
            current !== run ||
            run.status !== 'waiting_input' ||
            committed?.interactionId !== interactionId
          )
            return rejected('stale');
          if (
            pending.surface !== undefined &&
            (committed.surface === undefined ||
              committed.surface.revision !== surfaceRevision ||
              surfaceViewRevision(committed.surface) !== pending.viewRevision)
          )
            return rejected('stale');
          if (changes !== undefined) {
            if (changes.privateStrings.length > 0) {
              run.labels.add('private-user');
              run.submittedText = true;
              registerPrivate(changes.privateStrings, run.privateValues);
            }
            if (payloadSchema !== undefined) labelPayload(run, payloadSchema, payload);
          }
          if (options.recovery !== undefined) {
            try {
              const accepted = await options.recovery.acceptSubmission(sessionId, {
                interactionId,
                action,
                payload: copyRecoveryJson(payload),
              });
              if (accepted === 'duplicate') return rejected('duplicate');
              if (accepted !== 'accepted') return rejected('unrecoverable');
            } catch (error) {
              report({ kind: 'dispatch_failed', runId: run.runId, error });
              return rejected(failureCode(error, 'unavailable'));
            }
            if (disposing || current !== run || run.status !== 'waiting_input')
              return rejected('stale');
          }
          const entry: InboxEntry = { interactionId, action, payload, status: 'accepted' };
          run.inbox.set(interactionId, entry);
          if (!run.submittedText && containsText(payload)) run.submittedText = true;
          if (pending.surface === undefined && payloadSchema !== undefined)
            labelPayload(run, payloadSchema, payload);
          run.status = 'running';
          delete run.pending;
          // Register settlement before publishing: a listener may dispose synchronously.
          startSegment(run, { type: 'resume', interactionId, action, payload }, parent);
          publish();
          return { status: 'accepted', interactionId };
        } catch (error) {
          report({ kind: 'dispatch_failed', runId: run.runId, error });
          return rejected(failureCode(error, 'executor_error'));
        } finally {
          delete run.dispatching;
        }
      })();
      checkpointChecks.add(checking);
      void checking.then(() => checkpointChecks.delete(checking));
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
        await waitForSettlement(
          Promise.allSettled([settlement, ...checkpointChecks]).then(() => {}),
        );
        await disposeExecutor();
        state = 'disposed';
        publish();
        onDisposed();
        resolveDisposal();
      })();
      return disposal;
    },
  };
  return {
    instance,
    ...(warn === undefined
      ? {}
      : {
          checkDevelopmentWarnings: async (): Promise<void> => {
            for (const name of Object.keys(definition.capabilities?.optional ?? {})) {
              if (
                !Object.hasOwn(options.bindings ?? {}, name) ||
                options.bindings?.[name] === undefined
              )
                warn({ code: 'capability_unbound', name });
            }
            await router.checkDevelopmentWarnings(warn);
          },
        }),
  };
}
