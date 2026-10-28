// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type TracerProvider, trace } from '@opentelemetry/api';
import { createAgentInstance } from './agent-instance.js';
import { budgetLimits } from './budgets.js';
import type { CapabilityBinding } from './capabilities.js';
import { dataPolicy } from './capability-broker.js';
import type { AgentDefinition, BindingsFor } from './definition.js';
import { GalaxieError } from './errors.js';
import type { ExecutorAdapter } from './executor.js';
import type { AppId, InstanceId, PrincipalScope, RunId } from './ids.js';
import type { AgentInstance } from './instance.js';
import type { BudgetLimits, DataPolicy } from './policy.js';
import type { InferInput } from './schema.js';
import { VERSION } from './version.js';

export interface DiagnosticEvent {
  readonly kind:
    | 'prepare_failed'
    | 'run_failed'
    | 'executor_dispose_failed'
    | 'late_event'
    | 'protocol_violation'
    | 'listener_threw'
    | 'late_result'
    | 'capability_failed';
  readonly instanceId: InstanceId;
  readonly runId?: RunId;
  /** Host-only evidence, possibly including binding-supplied private content. Never forward it
   * to a destination private-user may not reach; never stored in snapshots, events or traces. */
  readonly error?: unknown;
}

export interface CreateOptions<Agent = unknown, Services = unknown> {
  readonly principalScope: PrincipalScope;
  readonly agent: Agent;
  readonly services?: Services;
  readonly bindings?: Readonly<Record<string, CapabilityBinding<never, unknown>>>;
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
  readonly tracerProvider?: TracerProvider;
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

/** Creates a runtime synchronously. Each created instance owns a fresh session. */
export function createRuntime<const Adapters extends readonly ExecutorAdapter<unknown, unknown>[]>(
  options: RuntimeOptions<Adapters>,
): Runtime<Adapters> {
  if (options.appId === '') throw new GalaxieError('invalid', 'An application ID is required.');
  const limits = budgetLimits(options.budgets);
  const policy = dataPolicy(options.dataPolicy);
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
  return {
    async create(definition, createOptions) {
      if (disposal !== undefined) throw new GalaxieError('invalid', 'The runtime was disposed.');
      const executor = executors.get(definition.executor);
      if (executor === undefined) {
        throw new GalaxieError('unsupported', 'The requested executor is not registered.');
      }
      const instance = createAgentInstance(
        definition,
        executor,
        createOptions,
        { appId: options.appId, tracer, limits, policy },
        () => instances.delete(instance),
        options.diagnostics,
      );
      instances.add(instance);
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
