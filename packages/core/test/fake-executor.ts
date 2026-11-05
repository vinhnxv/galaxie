// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import {
  type AgentInstance,
  type BudgetLimits,
  type CapabilityBinding,
  type CapabilityRequests,
  createRuntime,
  type DataPolicy,
  type DiagnosticEvent,
  defineAgentDefinition,
  type ExecutorAdapter,
  type ExecutorAgent,
  type ExecutorEvent,
  type ExecutorFeatures,
  type RunRequest,
  type Runtime,
  type Schema,
} from '../src/index.js';

export interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

export function deferred<Value>(): Deferred<Value> {
  let resolve: (value: Value) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export type ScriptStep =
  | ExecutorEvent
  | { readonly wait: Promise<void> }
  | { readonly throw: unknown };
export type Script =
  | readonly ScriptStep[]
  | ((request: RunRequest) => AsyncIterable<ExecutorEvent>);

export class FakeExecutor implements ExecutorAdapter<unknown, unknown> {
  readonly id: 'fake' = 'fake';
  readonly version: string = '1.0.0';
  readonly features: ExecutorFeatures = {
    interrupts: true,
    resume: false,
    checkpoints: false,
    streaming: true,
    subgraphs: false,
  };
  readonly requests: RunRequest[] = [];
  readonly prepareSignals: AbortSignal[] = [];
  readonly prepares: Array<() => Promise<ExecutorAgent>> = [];
  readonly scripts: Script[];
  prepareCalls: number = 0;
  disposeCalls: number = 0;
  iteratorReturns: number = 0;
  disposeError: unknown;
  readonly agent: ExecutorAgent;

  constructor(scripts: Script[] = []) {
    this.scripts = scripts;
    this.agent = {
      run: (request) => {
        this.requests.push(request);
        const script = this.scripts.shift() ?? [{ type: 'output', output: 'done' }];
        if (typeof script === 'function') return script(request);
        let index = 0;
        return {
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<ExecutorEvent>> => {
              while (index < script.length) {
                const step = script[index++];
                if (step === undefined) break;
                if ('wait' in step) await step.wait;
                else if ('throw' in step) throw step.throw;
                else return { done: false, value: step };
              }
              return { done: true, value: undefined };
            },
            return: async (): Promise<IteratorResult<ExecutorEvent>> => {
              this.iteratorReturns++;
              return { done: true, value: undefined };
            },
          }),
        };
      },
      pending: async () => undefined,
      dispose: async () => {
        this.disposeCalls++;
        if (this.disposeError !== undefined) throw this.disposeError;
      },
    };
  }

  async prepare(
    _agent: unknown,
    _services: unknown,
    options: { readonly signal: AbortSignal },
  ): Promise<ExecutorAgent> {
    this.prepareCalls++;
    this.prepareSignals.push(options.signal);
    return this.prepares.shift()?.() ?? this.agent;
  }
}

export const definition: ReturnType<
  typeof defineAgentDefinition<{
    readonly id: 'tests/agent';
    readonly version: '1.0.0';
    readonly executor: 'fake';
    readonly input: z.ZodString;
  }>
> = defineAgentDefinition({
  id: 'tests/agent',
  version: '1.0.0',
  executor: 'fake',
  input: z.string(),
});

export interface ReadyFixture {
  readonly executor: FakeExecutor;
  readonly runtime: Runtime<readonly [FakeExecutor]>;
  readonly instance: AgentInstance<string, unknown>;
}

export async function ready(scripts: Script[] = []): Promise<ReadyFixture> {
  const executor = new FakeExecutor(scripts);
  const runtime = createRuntime({ appId: 'tests', executors: [executor] });
  const instance = await runtime.create(definition, { principalScope: 'user', agent: {} });
  await instance.prepare();
  return { executor, runtime, instance };
}

/** Flush the promise-only executor fixture without advancing its controlled timers. */
export async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

export async function collect<Value>(events: AsyncIterable<Value>): Promise<Value[]> {
  const result: Value[] = [];
  for await (const event of events) result.push(event);
  return result;
}

export function stream(data: unknown): ExecutorEvent {
  return { type: 'stream', executor: 'fake', path: [], mode: 'values', data };
}

export function binding(overrides: Partial<CapabilityBinding> = {}): CapabilityBinding {
  return {
    kind: 'read',
    destination: 'in-browser',
    timeoutMs: 1000,
    concurrency: 1,
    grantScope: 'instance',
    approval: 'none',
    retry: 'none',
    invoke: async (input) => input,
    ...overrides,
  };
}

export async function brokerFixture(
  options: {
    readonly input?: Schema;
    readonly requests?: CapabilityRequests;
    readonly bindings?: Readonly<Record<string, CapabilityBinding>>;
    readonly scripts?: Script[];
    readonly budgets?: Partial<BudgetLimits>;
    readonly dataPolicy?: DataPolicy;
  } = {},
): Promise<{
  readonly runtime: Runtime<readonly [FakeExecutor]>;
  readonly executor: FakeExecutor;
  readonly instance: AgentInstance<unknown, unknown>;
  readonly diagnostics: DiagnosticEvent[];
  readonly scriptErrors: unknown[];
}> {
  const scriptErrors: unknown[] = [];
  const scripts = options.scripts?.map((script) =>
    typeof script !== 'function'
      ? script
      : async function* (request: RunRequest): AsyncGenerator<ExecutorEvent> {
          try {
            yield* script(request);
          } catch (error) {
            scriptErrors.push(error);
            throw error;
          }
        },
  );
  const executor = new FakeExecutor(scripts);
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'broker-tests',
    executors: [executor],
    diagnostics: (event) => diagnostics.push(event),
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    ...(options.dataPolicy === undefined ? {} : { dataPolicy: options.dataPolicy }),
  });
  const instance = await runtime.create(
    {
      ...definition,
      input: options.input ?? z.string(),
      capabilities: {
        optional: options.requests ?? {
          'echo@1': { input: z.string(), output: z.string(), kind: 'read' },
        },
      },
    },
    {
      principalScope: 'test-user',
      agent: {},
      bindings: options.bindings ?? { 'echo@1': binding() },
    },
  );
  await instance.prepare();
  return { runtime, executor, instance, diagnostics, scriptErrors };
}
