// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type TracerProvider, trace } from '@opentelemetry/api';
import { createAgentInstance } from './agent-instance.js';
import { budgetLimits } from './budgets.js';
import type { CapabilityBinding } from './capabilities.js';
import { dataPolicy } from './capability-broker.js';
import type { ConfirmationOptions } from './confirmations.js';
import type { AgentDefinition, BindingsFor } from './definition.js';
import {
  checkPageDevelopmentWarnings,
  createDevelopmentWarnings,
  type DevelopmentWarning,
} from './development.js';
import { GalaxieError } from './errors.js';
import type { ExecutorAdapter } from './executor.js';
import type { AppId, EffectId, InstanceId, PrincipalScope, RunId, SessionId } from './ids.js';
import type { AgentInstance } from './instance.js';
import { checkUiRequirements, normalizeUiBindings, type UiBindings } from './interactions.js';
import type { ModelRouting, OutputSafetyHook } from './models.js';
import {
  type BudgetLimits,
  type DataPolicy,
  DESTINATIONS,
  type DestinationClass,
} from './policy.js';
import type { RecoveryStore } from './recovery.js';
import type { InferInput } from './schema.js';
import { normalizeUrlAllowlist } from './urls.js';
import { VERSION } from './version.js';

export interface DiagnosticEvent {
  readonly kind:
    | 'prepare_failed'
    | 'run_failed'
    | 'dispatch_failed'
    | 'restore_failed'
    | 'executor_dispose_failed'
    | 'late_event'
    | 'protocol_violation'
    | 'interaction_rejected'
    | 'listener_threw'
    | 'late_result'
    | 'capability_failed'
    | 'effect_outcome_unknown'
    | 'confirmation_requested'
    | 'confirmation_declined'
    | 'confirmation_expired'
    | 'confirmation_invalidated'
    | 'model_failed'
    | 'output_blocked'
    | 'output_safety_failed'
    | 'output_safety_unset';
  readonly instanceId: InstanceId;
  readonly runId?: RunId;
  /** Identifier only, for host reconciliation of an earlier write with an unknown outcome. */
  readonly effectId?: EffectId;
  /** Host-only evidence, possibly including binding-supplied private content. Never forward it
   * to a destination private-user may not reach; never stored in snapshots, events or traces. */
  readonly error?: unknown;
}

export interface CreateOptions<Agent = unknown, Services = unknown> {
  readonly principalScope: PrincipalScope;
  readonly agent: Agent;
  /** Restore-only session; the host must scope it and the checkpointer to this principal. */
  readonly sessionId?: SessionId;
  /** Durable inbox and write journal, scoped to the checkpointer's app and principal. */
  readonly recovery?: RecoveryStore;
  readonly services?: Services;
  readonly bindings?: Readonly<Record<string, CapabilityBinding<never, unknown>>>;
  /** Host-rendered, single-use capability approvals, held only in page memory. */
  readonly confirmations?: ConfirmationOptions;
  /** Per-role providers, consent and ephemeral credentials (ADR-0006). */
  readonly models?: ModelRouting;
  /** Supported components, their actions and host-assigned surfaces. */
  readonly ui?: UiBindings;
}

export interface RuntimeOptions<
  Adapters extends readonly ExecutorAdapter<unknown, unknown>[] = readonly ExecutorAdapter<
    unknown,
    unknown
  >[],
> {
  readonly appId: AppId;
  readonly executors: Adapters;
  readonly diagnostics?: (event: DiagnosticEvent) => void;
  /** Opt-in, content-free development advice. Omit in production to skip all checks. */
  readonly developmentWarnings?: (warning: DevelopmentWarning) => void;
  /** Checks routed model output before release; failures block the call. */
  readonly outputSafety?: OutputSafetyHook;
  readonly tracerProvider?: TracerProvider;
  /** Exact origins permitted in interaction URL props; the default permits none. */
  readonly urlAllowlist?: readonly string[];
  /** Development-only verbatim text in spans; declare the final recipient of exported spans. */
  readonly developmentTraceText?: { readonly destination: DestinationClass };
  readonly dataPolicy?: DataPolicy;
  readonly budgets?: Partial<BudgetLimits>;
}

type MatchingAdapter<
  Adapters extends readonly ExecutorAdapter<unknown, unknown>[],
  Id extends string,
> = [Adapters[number]] extends [never]
  ? ExecutorAdapter<unknown, unknown>
  : Extract<Adapters[number], { readonly id: Id }> extends never
    ? Adapters[number]
    : Extract<Adapters[number], { readonly id: Id }>;

type AgentOf<Adapter> =
  Adapter extends ExecutorAdapter<infer Agent, infer _Services> ? Agent : never;
type ServicesOf<Adapter> =
  Adapter extends ExecutorAdapter<infer _Agent, infer Services> ? Services : never;

export interface Runtime<
  Adapters extends readonly ExecutorAdapter<unknown, unknown>[] = readonly ExecutorAdapter<
    unknown,
    unknown
  >[],
> {
  create<const Definition extends AgentDefinition>(
    definition: Definition,
    options: CreateOptions<
      AgentOf<MatchingAdapter<Adapters, Definition['executor']>>,
      ServicesOf<MatchingAdapter<Adapters, Definition['executor']>>
    > &
      (Definition extends { readonly capabilities: { readonly required: infer Required } }
        ? keyof Required extends never
          ? { readonly bindings?: BindingsFor<Definition> }
          : { readonly bindings: BindingsFor<Definition> }
        : { readonly bindings?: BindingsFor<Definition> }),
  ): Promise<AgentInstance<InferInput<Definition['input']>, unknown>>;
  dispose(): Promise<void>;
}

/** Creates a runtime synchronously. Instances mint a fresh session unless the host adopts one for restore. */
export function createRuntime<const Adapters extends readonly ExecutorAdapter<unknown, unknown>[]>(
  options: RuntimeOptions<Adapters>,
): Runtime<Adapters> {
  if (options.appId === '') throw new GalaxieError('invalid', 'An application ID is required.');
  const outputSafety = options.outputSafety;
  if (outputSafety !== undefined && typeof outputSafety !== 'function')
    throw new GalaxieError('invalid', 'The output safety hook must be a function.');
  const limits = budgetLimits(options.budgets);
  const policy = dataPolicy(options.dataPolicy);
  const urlAllowlist = normalizeUrlAllowlist(options.urlAllowlist);
  const traceText = options.developmentTraceText;
  if (
    traceText !== undefined &&
    (traceText === null || !DESTINATIONS.includes(traceText.destination))
  )
    throw new GalaxieError('invalid', 'The development trace destination is invalid.');
  const developmentTraceText =
    traceText === undefined ? undefined : Object.freeze({ destination: traceText.destination });
  const executors = new Map<string, ExecutorAdapter<unknown, unknown>>();
  for (const executor of options.executors) {
    if (executors.has(executor.id)) {
      throw new GalaxieError('invalid', 'Executor IDs must be unique.');
    }
    executors.set(executor.id, executor);
  }
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new GalaxieError('unsupported', 'The runtime requires crypto.randomUUID.');
  }
  const instances = new Set<AgentInstance<unknown, unknown>>();
  const tracer = (options.tracerProvider ?? trace.getTracerProvider()).getTracer(
    '@galaxie/core',
    VERSION,
  );
  let disposal: Promise<void> | undefined;
  const developmentWarnings =
    options.developmentWarnings === undefined
      ? undefined
      : createDevelopmentWarnings(options.developmentWarnings);
  if (developmentWarnings !== undefined) checkPageDevelopmentWarnings(developmentWarnings);
  return {
    async create(definition, createOptions) {
      if (disposal !== undefined) throw new GalaxieError('invalid', 'The runtime was disposed.');
      if (
        createOptions.sessionId !== undefined &&
        (typeof createOptions.sessionId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            createOptions.sessionId,
          ) ||
          createOptions.sessionId.length !== 36)
      )
        throw new GalaxieError('invalid', 'The session ID is invalid.');
      const executor = executors.get(definition.executor);
      if (executor === undefined) {
        throw new GalaxieError('unsupported', 'The requested executor is not registered.');
      }
      const ui = createOptions.ui === undefined ? undefined : normalizeUiBindings(createOptions.ui);
      if (
        ui !== undefined &&
        definition.ui !== undefined &&
        !checkUiRequirements(ui, definition.ui)
      )
        throw new GalaxieError('unsupported', 'The required UI is not bound.');
      const { instance, checkDevelopmentWarnings } = createAgentInstance(
        definition,
        executor,
        ui === undefined ? createOptions : { ...createOptions, ui },
        {
          appId: options.appId,
          tracer,
          limits,
          policy,
          urlAllowlist,
          ...(developmentWarnings === undefined ? {} : { developmentWarnings }),
          ...(outputSafety === undefined ? {} : { outputSafety }),
          ...(developmentTraceText === undefined ? {} : { developmentTraceText }),
        },
        () => instances.delete(instance),
        options.diagnostics,
      );
      instances.add(instance);
      await checkDevelopmentWarnings?.();
      return instance;
    },
    dispose(): Promise<void> {
      // Install the shared promise before any instance can notify a reentrant listener.
      if (disposal === undefined) {
        disposal = Promise.resolve().then(async () => {
          await Promise.all([...instances].map((instance) => instance.dispose()));
          instances.clear();
        });
      }
      return disposal;
    },
  };
}
