// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type Annotations, readAnnotations } from './annotations.js';
import { BudgetExceeded, deadlineTimer, type RunBudget } from './budgets.js';
import type {
  CapabilityBinding,
  CapabilityContext,
  CapabilityPort,
  CapabilityRequest,
} from './capabilities.js';
import type { AgentDefinition } from './definition.js';
import { type ErrorCode, GalaxieError, isGalaxieError, toErrorInfo } from './errors.js';
import type { AgentRef, EffectId, RunId } from './ids.js';
import {
  type BudgetLimits,
  type DataLabel,
  type DataPolicy,
  DEFAULT_DATA_POLICY,
  DESTINATIONS,
  type DestinationAllowlist,
} from './policy.js';
import type { DiagnosticEvent } from './runtime.js';
import type { Schema } from './schema.js';
import type { RunInstrumentation } from './tracing.js';

type Policy = Readonly<Record<DataLabel, DestinationAllowlist>>;
export function dataPolicy(overrides: DataPolicy = {}): Policy {
  const result = { ...DEFAULT_DATA_POLICY };
  for (const [label, allowlist] of Object.entries(overrides)) {
    if (
      !Object.hasOwn(DEFAULT_DATA_POLICY, label) ||
      typeof allowlist !== 'object' ||
      allowlist === null ||
      !Array.isArray(allowlist.allow) ||
      !allowlist.allow.every((destination: unknown) => DESTINATIONS.includes(destination as never))
    )
      throw new GalaxieError('invalid', 'The data policy is invalid.');
    result[label as DataLabel] = Object.freeze({ allow: Object.freeze([...allowlist.allow]) });
  }
  return Object.freeze(result);
}
function failure(code: ErrorCode): GalaxieError {
  return new GalaxieError(code, toErrorInfo(code).message);
}
function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, ' ').trim();
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null)
    return Object.entries(value).flatMap(([key, value]) => [key, ...strings(value)]);
  return [];
}
export function registerPrivate(values: Iterable<string>, registered: Set<string>): void {
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized.length >= 8) registered.add(normalized);
  }
}

interface Slot {
  readonly start: () => void;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}
class Concurrency {
  readonly limit: number;
  #active = 0;
  readonly #queue: Slot[] = [];
  constructor(limit: number) {
    this.limit = limit;
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        const index = this.#queue.indexOf(slot);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(failure('cancelled'));
      };
      const slot: Slot = {
        signal,
        abort,
        start: () => {
          signal.removeEventListener('abort', abort);
          this.#active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.#active--;
            this.#drain();
          });
        },
      };
      if (signal.aborted) {
        abort();
        return;
      }
      this.#queue.push(slot);
      signal.addEventListener('abort', abort, { once: true });
      this.#drain();
    });
  }
  #drain(): void {
    while (this.#active < this.limit) {
      const slot = this.#queue.shift();
      if (slot === undefined) return;
      if (slot.signal.aborted) slot.abort();
      else slot.start();
    }
  }
}
interface Compiled {
  readonly request: CapabilityRequest;
  readonly input: Annotations;
  readonly output: Annotations;
  readonly binding?: CapabilityBinding;
  readonly slots?: Concurrency;
}
export interface BrokerRun {
  readonly runId: RunId;
  readonly signal: AbortSignal;
  readonly labels: Set<DataLabel>;
  readonly privateValues: Set<string>;
  readonly budget: RunBudget;
  readonly tracing: RunInstrumentation;
  readonly grants: ReadonlySet<string>;
  active(): boolean;
  labelsChanged(): void;
  failBudget(name: keyof BudgetLimits): void;
}

/** One broker per instance: grants and concurrency never cross principals or instances. */
export class CapabilityBroker {
  readonly input: Annotations;
  readonly #capabilities = new Map<string, Compiled>();
  readonly #policy: Policy;
  readonly #agent: AgentRef;
  readonly #principal: string;
  readonly #report: (event: Omit<DiagnosticEvent, 'instanceId'>) => void;
  constructor(
    definition: AgentDefinition,
    bindings: Readonly<Record<string, CapabilityBinding<never, unknown>>> | undefined,
    policy: Policy,
    principal: string,
    report: (event: Omit<DiagnosticEvent, 'instanceId'>) => void,
  ) {
    this.#policy = policy;
    this.#principal = principal;
    this.#report = report;
    this.#agent = Object.freeze({ id: definition.id, version: definition.version, hash: '' });
    const cache = new Map<Schema, Annotations>();
    const annotations = (schema: Schema): Annotations => {
      const found = cache.get(schema);
      if (found !== undefined) return found;
      const result = readAnnotations(schema);
      cache.set(schema, result);
      return result;
    };
    this.input = annotations(definition.input);
    const requests = new Map<string, CapabilityRequest>([
      ...Object.entries(definition.capabilities?.required ?? {}),
      ...Object.entries(definition.capabilities?.optional ?? {}),
    ]);
    for (const name of Object.keys(bindings ?? {}))
      if (!requests.has(name)) throw failure('invalid');
    for (const name of Object.keys(definition.capabilities?.required ?? {}))
      if (!Object.hasOwn(bindings ?? {}, name) || bindings?.[name] === undefined)
        throw failure('invalid');
    for (const [name, request] of requests) {
      const supplied = Object.hasOwn(bindings ?? {}, name) ? bindings?.[name] : undefined;
      const binding =
        supplied === undefined ? undefined : (Object.freeze({ ...supplied }) as CapabilityBinding);
      if (
        binding !== undefined &&
        (!Number.isFinite(binding.timeoutMs) ||
          binding.timeoutMs <= 0 ||
          !Number.isInteger(binding.concurrency) ||
          binding.concurrency < 1 ||
          !['read', 'write', 'device', 'ui'].includes(binding.kind) ||
          !DESTINATIONS.includes(binding.destination) ||
          !['app', 'principal', 'instance', 'run'].includes(binding.grantScope) ||
          !['none', 'confirm'].includes(binding.approval) ||
          !['none', 'idempotent', 'idempotency-key'].includes(binding.retry) ||
          typeof binding.invoke !== 'function')
      )
        throw failure('invalid');
      const input = annotations(request.input);
      const output = annotations(request.output);
      this.#capabilities.set(name, {
        request,
        input,
        output,
        ...(binding === undefined ? {} : { binding, slots: new Concurrency(binding.concurrency) }),
      });
    }
  }
  validateGrants(grants: readonly string[] = []): ReadonlySet<string> {
    if (!Array.isArray(grants)) throw failure('invalid');
    for (const name of grants)
      if (this.#capabilities.get(name)?.binding?.grantScope !== 'run') throw failure('invalid');
    return new Set(grants);
  }
  port(run: BrokerRun): CapabilityPort {
    return {
      call: async (name, input, options) => {
        const compiled = this.#capabilities.get(name);
        const binding = compiled?.binding;
        const span = run.tracing.startCapability(
          {
            ...(compiled === undefined ? {} : { name }),
            ...(binding === undefined
              ? {}
              : { kind: binding.kind, destination: binding.destination }),
          },
          options?.parent,
        );
        let stopped = false;
        let budgetFailure: BudgetExceeded | undefined;
        let abortCode: ErrorCode = 'cancelled';
        const controller = new AbortController();
        const runAbort = (): void => {
          if (!controller.signal.aborted) {
            abortCode = 'cancelled';
            controller.abort();
          }
        };
        const callerAbort = (): void => {
          if (!controller.signal.aborted) {
            abortCode = 'cancelled';
            controller.abort();
          }
        };
        const assertActive = (): void => {
          if (!run.active() || run.signal.aborted || options?.signal?.aborted)
            throw failure('cancelled');
          if (controller.signal.aborted) throw failure(abortCode);
        };
        let clearTimer: (() => void) | undefined;
        let settledRelease: (() => void) | undefined;
        let aborted: (() => void) | undefined;
        const checkPolicy = (value: unknown): void => {
          if (binding === undefined || compiled === undefined) throw failure('denied');
          if (
            compiled.input.freeTextStrings(value).some((value) => value.length > 0) &&
            [...run.labels].some(
              (label) => !this.#policy[label].allow.includes(binding.destination),
            )
          )
            throw failure('denied');
          if (!this.#policy['private-user'].allow.includes(binding.destination)) {
            for (const candidateValue of strings(value)) {
              const candidate = normalize(candidateValue);
              for (const registered of run.privateValues)
                if (
                  candidate.includes(registered) ||
                  (candidate.length >= 8 && registered.includes(candidate))
                )
                  throw failure('denied');
            }
          }
        };
        try {
          assertActive();
          if (compiled === undefined || binding === undefined || compiled.slots === undefined)
            throw failure('denied');
          const slots = compiled.slots;
          if (binding.grantScope === 'run' && !run.grants.has(name)) throw failure('denied');
          if (binding.approval === 'confirm') throw failure('unsupported');
          run.signal.addEventListener('abort', runAbort, { once: true });
          options?.signal?.addEventListener('abort', callerAbort, { once: true });
          clearTimer = deadlineTimer(binding.timeoutMs, () => {
            if (!controller.signal.aborted) {
              abortCode = 'timeout';
              controller.abort();
            }
          });
          const abortedPromise = new Promise<never>((_resolve, reject) => {
            aborted = () => reject(budgetFailure ?? failure(abortCode));
            controller.signal.addEventListener('abort', aborted, { once: true });
          });
          const perform = async (): Promise<unknown> => {
            const validate = async (schema: Schema, raw: unknown): Promise<unknown> => {
              try {
                const result = await schema['~standard'].validate(raw);
                assertActive();
                if (result.issues !== undefined) throw failure('invalid');
                return result.value;
              } catch (error) {
                assertActive();
                if (isGalaxieError(error) && error.code === 'invalid') throw error;
                throw failure('invalid');
              }
            };
            const value = await validate(compiled.request.input, input);
            assertActive();
            run.budget.payload(value);
            checkPolicy(value);
            run.budget.reserveToolCall();
            const release = await slots.acquire(controller.signal);
            let invoked = false;
            let hostSettled = false;
            try {
              assertActive();
              checkPolicy(value);
              const context: CapabilityContext = {
                signal: controller.signal,
                effectId: globalThis.crypto.randomUUID() as EffectId,
                runId: run.runId,
                principalScope: this.#principal,
                agent: this.#agent,
              };
              let execution: Promise<unknown>;
              try {
                invoked = true;
                execution = Promise.resolve(binding.invoke(value, context));
              } catch (error) {
                execution = Promise.reject(error);
              }
              const result = await execution
                .then(
                  (value) => {
                    if (stopped || !run.active() || controller.signal.aborted) {
                      this.#report({ kind: 'late_result', runId: run.runId });
                      throw failure('cancelled');
                    }
                    return value;
                  },
                  (error: unknown) => {
                    this.#report({ kind: 'capability_failed', runId: run.runId, error });
                    throw error;
                  },
                )
                .finally(() => {
                  hostSettled = true;
                  settledRelease = release;
                  if (stopped) release();
                });
              assertActive();
              run.budget.payload(result);
              const output = await validate(compiled.request.output, result);
              assertActive();
              for (const label of compiled.output.labels) run.labels.add(label);
              registerPrivate(compiled.output.privateStrings(output), run.privateValues);
              run.labelsChanged();
              return output;
            } finally {
              if (!invoked || hostSettled) release();
            }
          };
          const operation = perform().catch((error: unknown) => {
            if (
              !stopped &&
              run.active() &&
              (error instanceof BudgetExceeded ||
                (isGalaxieError(error) && error.code === 'budget_exceeded'))
            ) {
              budgetFailure =
                error instanceof BudgetExceeded ? error : new BudgetExceeded('payloadBytes');
              span.end({ status: 'error', code: 'budget_exceeded' });
              run.failBudget(budgetFailure.budget);
            }
            throw error;
          });
          const result = await Promise.race([operation, abortedPromise]);
          assertActive();
          span.end({ status: 'ok' });
          return result;
        } catch (error) {
          const code: ErrorCode =
            budgetFailure !== undefined
              ? 'budget_exceeded'
              : controller.signal.aborted
                ? abortCode
                : isGalaxieError(error)
                  ? error.code
                  : 'unavailable';
          span.end(code === 'cancelled' ? { status: 'cancelled' } : { status: 'error', code });
          throw failure(code);
        } finally {
          stopped = true;
          settledRelease?.();
          clearTimer?.();
          run.signal.removeEventListener('abort', runAbort);
          options?.signal?.removeEventListener('abort', callerAbort);
          if (aborted !== undefined) controller.signal.removeEventListener('abort', aborted);
        }
      },
    };
  }
}
