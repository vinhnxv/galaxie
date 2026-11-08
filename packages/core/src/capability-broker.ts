// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type Annotations, readAnnotations } from './annotations.js';
import { BudgetExceeded, deadlineTimer, type RunBudget } from './budgets.js';
import type {
  CapabilityBinding,
  CapabilityContext,
  CapabilityName,
  CapabilityPort,
  CapabilityRequest,
} from './capabilities.js';
import { type Approval, approvedCopy, type ConfirmationGate, digest } from './confirmations.js';
import type { AgentDefinition } from './definition.js';
import { type ErrorCode, GalaxieError, isGalaxieError, toErrorInfo } from './errors.js';
import { getHttpCapability, type HttpDescriptor } from './http-capability.js';
import type { AgentRef, EffectId, RunId, SessionId } from './ids.js';
import {
  type BudgetLimits,
  type DataLabel,
  type DataPolicy,
  DEFAULT_DATA_POLICY,
  DESTINATIONS,
  type DestinationAllowlist,
  labelsAllow,
} from './policy.js';
import { containsPrivateEncoded, registerPrivate } from './private-values.js';
import {
  copyRecoveryJson,
  type EffectRecord,
  RECOVERY_FORMAT_VERSION,
  type RecoveryJson,
  type RecoveryStore,
  validateEffectRecord,
} from './recovery.js';
import type { DiagnosticEvent } from './runtime.js';
import type { Schema } from './schema.js';
import type { RunInstrumentation } from './tracing.js';

type Policy = Readonly<Record<DataLabel, DestinationAllowlist>>;

/** Host policy only: no invocation authority or implementation is exposed to adapters. */
export interface CapabilityBindingPolicy {
  readonly kind: CapabilityBinding['kind'];
  readonly approval: CapabilityBinding['approval'];
  readonly confirmationAvailable: boolean;
}

const bindingPolicies = new WeakMap<CapabilityPort, ReadonlyMap<string, CapabilityBindingPolicy>>();

/** Immutable host policy for a broker-created port; unknown ports/bindings have no policy. */
export function capabilityBindingPolicy(
  port: CapabilityPort,
  name: string,
): CapabilityBindingPolicy | undefined {
  return bindingPolicies.get(port)?.get(name);
}
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
function storageFailure(error: unknown): ErrorCode {
  if (
    typeof error === 'object' &&
    error !== null &&
    Object.getOwnPropertyDescriptor(error, 'invalidated')?.value === true
  )
    return 'stale';
  return typeof error === 'object' &&
    error !== null &&
    Object.getOwnPropertyDescriptor(error, 'fenced')?.value === true
    ? 'fenced'
    : 'unavailable';
}
async function journalEffectId(
  sessionId: SessionId,
  scope: string,
  name: string,
  ordinal: number,
): Promise<EffectId> {
  const hash = await digest([sessionId, scope, name, ordinal]);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${(
    (Number.parseInt(hash[16] as string, 16) & 3) | 8
  ).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}` as EffectId;
}

class WriteJournal {
  readonly effectId: EffectId;
  readonly #store: RecoveryStore;
  readonly #sessionId: SessionId;
  readonly #inputDigest: string;
  readonly #reportFailure: () => void;
  #tail: Promise<void> = Promise.resolve();
  #record: EffectRecord | undefined;
  #loaded = false;
  /** True once a dispatch may have happened: a loaded dispatched record, or the binding was invoked. */
  #dispatched = false;
  #successStarted = false;
  #failureRequested = false;
  #storeFailed = false;

  constructor(
    store: RecoveryStore,
    sessionId: SessionId,
    effectId: EffectId,
    inputDigest: string,
    reportFailure: () => void,
  ) {
    this.#store = store;
    this.#sessionId = sessionId;
    this.effectId = effectId;
    this.#inputDigest = inputDigest;
    this.#reportFailure = reportFailure;
  }

  async read(): Promise<EffectRecord | undefined> {
    let raw: unknown;
    try {
      raw = await this.#store.effect(this.#sessionId, this.effectId);
    } catch (error) {
      this.#reportFailure();
      throw failure(storageFailure(error));
    }
    const record = validateEffectRecord(raw);
    if (record !== undefined && record.inputDigest !== this.#inputDigest)
      throw failure('unrecoverable');
    this.#record = record;
    this.#loaded = true;
    this.#dispatched = record?.status === 'dispatched' || record?.status === 'outcome_unknown';
    return record;
  }

  write(status: Exclude<EffectRecord['status'], 'succeeded'>): Promise<void> {
    return this.#write({ status, inputDigest: this.#inputDigest }, false);
  }

  /** Called immediately before the binding is invoked; a failure after this point is unknown. */
  markInvoked(): void {
    this.#dispatched = true;
  }

  succeed(output: unknown): Promise<void> {
    return this.#write(
      { status: 'succeeded', inputDigest: this.#inputDigest, output: copyRecoveryJson(output) },
      true,
    );
  }

  fail(): Promise<void> {
    if (
      !this.#loaded ||
      this.#record?.status === 'succeeded' ||
      this.#successStarted ||
      this.#failureRequested ||
      this.#storeFailed ||
      this.#record?.status === 'outcome_unknown' ||
      this.#record?.status === 'failed'
    )
      return this.#tail;
    this.#failureRequested = true;
    return this.#write(
      { status: this.#dispatched ? 'outcome_unknown' : 'failed', inputDigest: this.#inputDigest },
      true,
    );
  }

  #write(record: EffectRecord, tolerateFailure: boolean): Promise<void> {
    const stamped = { ...record, formatVersion: RECOVERY_FORMAT_VERSION };
    const next = this.#tail.then(async () => {
      if (this.#record?.status === 'succeeded') return;
      if (
        this.#failureRequested &&
        (record.status === 'planned' ||
          record.status === 'dispatched' ||
          record.status === 'succeeded')
      )
        return;
      if (record.status === 'succeeded') this.#successStarted = true;
      try {
        await this.#store.recordEffect(this.#sessionId, this.effectId, stamped);
        this.#record = stamped;
      } catch (error) {
        this.#storeFailed = true;
        this.#reportFailure();
        const code = storageFailure(error);
        if (!tolerateFailure || code === 'fenced' || code === 'stale') throw failure(code);
      }
    });
    this.#tail = next.catch(() => {});
    return next;
  }
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null)
    return Object.entries(value).flatMap(([key, value]) => [key, ...strings(value)]);
  return [];
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
  readonly http?: HttpDescriptor;
  readonly request: CapabilityRequest;
  readonly input: Annotations;
  readonly output: Annotations;
  readonly binding?: CapabilityBinding;
  readonly slots?: Concurrency;
}
export interface BrokerRun {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly segmentKey: string;
  readonly effectOrdinals: Map<string, number>;
  readonly recovery?: RecoveryStore;
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
  readonly #confirmations: ConfirmationGate | undefined;
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
    confirmations?: ConfirmationGate,
  ) {
    this.#policy = policy;
    this.#confirmations = confirmations;
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
          (binding.reconcile !== undefined &&
            (typeof binding.reconcile !== 'function' || binding.retry !== 'none')) ||
          typeof binding.invoke !== 'function')
      )
        throw failure('invalid');
      if (
        binding?.approval === 'confirm' &&
        confirmations !== undefined &&
        !confirmations.capabilities.some((capability) => capability === name)
      )
        throw failure('invalid');
      const input = annotations(request.input);
      const output = annotations(request.output);
      const http = supplied === undefined ? undefined : getHttpCapability(supplied);
      if (binding !== undefined) http?.validate(input, binding);
      this.#capabilities.set(name, {
        request,
        ...(http === undefined ? {} : { http }),
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
    const port: CapabilityPort = {
      call: async (name, input, options) => {
        const compiled = this.#capabilities.get(name);
        const binding = compiled?.binding;
        const recovery = binding?.kind === 'write' ? run.recovery : undefined;
        const effectScope = options?.effectScope ?? run.segmentKey;
        const ordinalKey = JSON.stringify([effectScope, name]);
        const ordinal = run.effectOrdinals.get(ordinalKey) ?? 0;
        if (recovery !== undefined) run.effectOrdinals.set(ordinalKey, ordinal + 1);
        let journal: WriteJournal | undefined;
        let approval: Approval | undefined;
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
            !labelsAllow(this.#policy, run.labels, binding.destination)
          )
            throw failure('denied');
          if (!this.#policy['private-user'].allow.includes(binding.destination)) {
            if (
              strings(value).some((candidate) =>
                containsPrivateEncoded(candidate, run.privateValues),
              )
            )
              throw failure('denied');
          }
        };
        try {
          assertActive();
          if (compiled === undefined || binding === undefined || compiled.slots === undefined)
            throw failure('denied');
          const slots = compiled.slots;
          const settle = (output: unknown): unknown => {
            for (const label of compiled.output.labels) run.labels.add(label);
            registerPrivate(compiled.output.privateStrings(output), run.privateValues);
            run.labelsChanged();
            return output;
          };
          if (binding.grantScope === 'run' && !run.grants.has(name)) throw failure('denied');
          if (binding.approval === 'confirm' && this.#confirmations === undefined)
            throw failure('unsupported');
          run.signal.addEventListener('abort', runAbort, { once: true });
          options?.signal?.addEventListener('abort', callerAbort, { once: true });
          const startDeadline = (): void => {
            clearTimer = deadlineTimer(binding.timeoutMs, () => {
              if (!controller.signal.aborted) {
                abortCode = 'timeout';
                controller.abort();
              }
            });
          };
          if (binding.approval !== 'confirm') startDeadline();
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
            const validated = await validate(compiled.request.input, input);
            const value = binding.approval === 'confirm' ? approvedCopy(validated) : validated;
            assertActive();
            run.budget.payload(value);
            checkPolicy(value);
            run.budget.reserveToolCall();
            if (recovery !== undefined) {
              const [effectId, inputDigest] = await Promise.all([
                journalEffectId(run.sessionId, effectScope, name, ordinal),
                digest(copyRecoveryJson(value)),
              ]);
              assertActive();
              journal = new WriteJournal(recovery, run.sessionId, effectId, inputDigest, () =>
                this.#report({ kind: 'capability_failed', runId: run.runId }),
              );
              const record = await journal.read();
              assertActive();
              if (record?.status === 'succeeded') {
                run.budget.payload(record.output);
                return settle(record.output);
              }
              if (record?.status === 'dispatched' || record?.status === 'outcome_unknown') {
                await journal.write('outcome_unknown');
                assertActive();
                if (binding.retry === 'none' && binding.reconcile !== undefined) {
                  checkPolicy(value);
                  const consultController = new AbortController();
                  const abortConsult = (): void => consultController.abort();
                  controller.signal.addEventListener('abort', abortConsult, { once: true });
                  let consultAborted: (() => void) | undefined;
                  const consultAbort = new Promise<never>((_resolve, reject) => {
                    consultAborted = () => reject(failure(abortCode));
                    consultController.signal.addEventListener('abort', consultAborted, {
                      once: true,
                    });
                  });
                  const context: CapabilityContext = {
                    signal: consultController.signal,
                    effectId,
                    runId: run.runId,
                    principalScope: this.#principal,
                    agent: this.#agent,
                  };
                  const clearConsultTimer = deadlineTimer(binding.timeoutMs, () => {
                    if (!controller.signal.aborted) {
                      abortCode = 'timeout';
                      controller.abort();
                    }
                  });
                  let answer: unknown;
                  try {
                    try {
                      answer = await Promise.race([
                        Promise.resolve(binding.reconcile(effectId, context)),
                        consultAbort,
                      ]);
                    } catch (error) {
                      assertActive();
                      this.#report({ kind: 'capability_failed', runId: run.runId, error });
                    }
                    assertActive();
                  } finally {
                    clearConsultTimer();
                    controller.signal.removeEventListener('abort', abortConsult);
                    if (consultAborted !== undefined)
                      consultController.signal.removeEventListener('abort', consultAborted);
                  }
                  if (
                    typeof answer === 'object' &&
                    answer !== null &&
                    'outcome' in answer &&
                    answer.outcome === 'applied' &&
                    'output' in answer
                  ) {
                    run.budget.payload(answer.output);
                    const output = await validate(compiled.request.output, answer.output);
                    await journal.succeed(output);
                    assertActive();
                    const result = settle(output);
                    this.#report({ kind: 'effect_reconciled_applied', runId: run.runId, effectId });
                    return result;
                  }
                  if (
                    typeof answer !== 'object' ||
                    answer === null ||
                    !('outcome' in answer) ||
                    answer.outcome !== 'not-applied'
                  ) {
                    this.#report({
                      kind: 'effect_outcome_unknown',
                      runId: run.runId,
                      effectId,
                    });
                    throw failure('outcome_unknown');
                  }
                  assertActive();
                  checkPolicy(value);
                  this.#report({
                    kind: 'effect_reconciled_not_applied',
                    runId: run.runId,
                    effectId,
                  });
                  if (binding.approval !== 'confirm') {
                    clearTimer?.();
                    startDeadline();
                  }
                } else if (binding.retry === 'none') {
                  this.#report({
                    kind: 'effect_outcome_unknown',
                    runId: run.runId,
                    effectId,
                  });
                  throw failure('outcome_unknown');
                }
              }
              assertActive();
            }
            const effectId = journal?.effectId ?? (globalThis.crypto.randomUUID() as EffectId);
            if (binding.approval === 'confirm' && this.#confirmations !== undefined) {
              approval = await this.#confirmations.request(
                name as CapabilityName,
                value as RecoveryJson,
                effectId,
                run.runId,
                controller.signal,
                run.active,
                (code) => {
                  if (!controller.signal.aborted) {
                    abortCode = code;
                    controller.abort();
                  }
                },
              );
              assertActive();
              startDeadline();
            }
            if (journal !== undefined) {
              await journal.write('planned');
              assertActive();
            }
            const release = await slots.acquire(controller.signal);
            let invoked = false;
            let hostSettled = false;
            try {
              assertActive();
              checkPolicy(value);
              span.arguments(value);
              if (journal !== undefined) {
                await journal.write('dispatched');
                assertActive();
                checkPolicy(value);
              }
              if (approval !== undefined) {
                await approval.check();
                assertActive();
                checkPolicy(value);
                // Synchronous from here to invoke, so no microtask can change the policy in between.
                approval.consume();
              }
              const context: CapabilityContext = {
                signal: controller.signal,
                effectId,
                runId: run.runId,
                principalScope: this.#principal,
                agent: this.#agent,
              };
              let execution: Promise<unknown>;
              try {
                invoked = true;
                journal?.markInvoked();
                execution = Promise.resolve(
                  compiled.http === undefined
                    ? binding.invoke(value, context)
                    : compiled.http.invoke(
                        value,
                        context,
                        run.budget.limits.payloadBytes,
                        binding.destination,
                      ),
                );
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
                    // Only galaxie's own accounting may claim a run budget; host code cannot.
                    if (
                      isGalaxieError(error) &&
                      error.code === 'budget_exceeded' &&
                      !(error instanceof BudgetExceeded)
                    )
                      throw failure('unavailable');
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
              if (journal !== undefined) {
                await journal.succeed(output);
                assertActive();
              }
              return settle(output);
            } finally {
              if (!invoked || hostSettled) release();
            }
          };
          const operation = perform().catch(async (error: unknown) => {
            await journal?.fail();
            if (!stopped && run.active() && error instanceof BudgetExceeded) {
              budgetFailure = error;
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
          await journal?.fail();
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
          approval?.release();
          settledRelease?.();
          clearTimer?.();
          run.signal.removeEventListener('abort', runAbort);
          options?.signal?.removeEventListener('abort', callerAbort);
          if (aborted !== undefined) controller.signal.removeEventListener('abort', aborted);
        }
      },
    };
    const policies = new Map<string, CapabilityBindingPolicy>();
    for (const [name, { binding }] of this.#capabilities) {
      if (binding === undefined) continue;
      policies.set(
        name,
        Object.freeze({
          kind: binding.kind,
          approval: binding.approval,
          confirmationAvailable: this.#confirmations !== undefined,
        }),
      );
    }
    bindingPolicies.set(port, policies);
    return port;
  }
}
