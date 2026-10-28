// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { BudgetExceeded, type ModelReservation, type RunBudget } from './budgets.js';
import type { AgentDefinition } from './definition.js';
import { type ErrorCode, GalaxieError, toErrorInfo } from './errors.js';
import type { RunId } from './ids.js';
import type {
  ModelAvailability,
  ModelCall,
  ModelDescriptor,
  ModelPort,
  ModelPreparation,
  ModelRoleRequirements,
  ModelRoute,
  ModelRouting,
  ModelUsage,
  SelectedModelRoute,
} from './models.js';
import {
  type BudgetLimits,
  type DataLabel,
  DESTINATIONS,
  type DestinationAllowlist,
  type DestinationClass,
  labelsAllow,
} from './policy.js';
import type { DiagnosticEvent } from './runtime.js';

const MODEL_FEATURES = ['streaming', 'structured-output', 'tool-calling', 'cancellation'];

type Policy = Readonly<Record<DataLabel, DestinationAllowlist>>;
interface CompiledRole {
  readonly requirements: ModelRoleRequirements;
  readonly route: ModelRoute;
}
interface PendingDecision {
  readonly controller: AbortController;
  promise: Promise<boolean>;
  waiters: number;
  settled: boolean;
}

/** Uses the same mutable labels and accounting record as the capability broker (ADR-0014). */
export interface ModelRun {
  readonly runId: RunId;
  readonly signal: AbortSignal;
  readonly labels: Set<DataLabel>;
  readonly budget: RunBudget;
  active(): boolean;
  failBudget(name: keyof BudgetLimits): void;
  selectedRouteChanged(role: string, selected: SelectedModelRoute): void;
}

function failure(code: ErrorCode): GalaxieError {
  return new GalaxieError(code, toErrorInfo(code).message);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}
function primary(language: string): string {
  return language.split('-')[0]?.toLowerCase() ?? '';
}
function validUsage(usage: ModelUsage | undefined): usage is ModelUsage {
  return (
    record(usage) &&
    nonnegative(usage.inputTokens) &&
    Number.isInteger(usage.inputTokens) &&
    nonnegative(usage.outputTokens) &&
    Number.isInteger(usage.outputTokens)
  );
}

async function waitForHostOrAbort<Value>(
  promise: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  if (signal.aborted) throw failure('cancelled');
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(failure('cancelled'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Per-instance routing policy and consent memory; never receives messages (ADR-0017). */
export class ModelRouter {
  readonly summary: ModelPreparation;
  readonly #providers = new Map<string, ModelDescriptor>();
  readonly #roles = new Map<string, CompiledRole>();
  readonly #answered = new Map<string, boolean>();
  readonly #pending = new Map<string, PendingDecision>();
  readonly #selected = new Map<string, SelectedModelRoute>();
  readonly #policy: Policy;
  readonly #report: (event: Omit<DiagnosticEvent, 'instanceId'>) => void;
  readonly #consent: ModelRouting['consent'];
  readonly #availability: ModelRouting['availability'];
  readonly #download: ModelRouting['download'];
  #persistence: Promise<boolean> | undefined;
  readonly #getCredential: ModelRouting['getCredential'];
  #disposed = false;

  constructor(
    definition: AgentDefinition,
    routing: ModelRouting | undefined,
    policy: Policy,
    report: (event: Omit<DiagnosticEvent, 'instanceId'>) => void,
  ) {
    this.#policy = policy;
    this.#report = report;
    if (
      routing !== undefined &&
      (!record(routing) || !record(routing.providers) || !record(routing.roles))
    )
      throw failure('invalid');
    this.#consent = routing?.consent;
    this.#getCredential = routing?.getCredential;
    this.#availability = routing?.availability;
    this.#download = routing?.download;
    if (
      (this.#consent !== undefined && typeof this.#consent !== 'function') ||
      (this.#availability !== undefined && typeof this.#availability !== 'function') ||
      (this.#download !== undefined && typeof this.#download !== 'function') ||
      (this.#getCredential !== undefined && typeof this.#getCredential !== 'function')
    )
      throw failure('invalid');
    for (const [providerId, descriptor] of Object.entries(routing?.providers ?? {})) {
      if (
        !/^[A-Za-z0-9._-]{1,64}$/.test(providerId) ||
        !record(descriptor) ||
        !DESTINATIONS.includes(descriptor.destination) ||
        descriptor.modality !== 'text' ||
        !strings(descriptor.features) ||
        !descriptor.features.every((feature) => MODEL_FEATURES.includes(feature)) ||
        (descriptor.languages !== undefined && !strings(descriptor.languages)) ||
        (descriptor.credential !== undefined && typeof descriptor.credential !== 'boolean') ||
        (descriptor.credential === true && this.#getCredential === undefined)
      )
        throw failure('invalid');
      const pricing = descriptor.pricing;
      if (
        pricing !== 'unknown' &&
        (!record(pricing) ||
          !nonnegative(pricing.inputPerToken) ||
          !nonnegative(pricing.outputPerToken))
      )
        throw failure('invalid');
      this.#providers.set(
        providerId,
        Object.freeze({
          ...descriptor,
          features: Object.freeze([...descriptor.features]),
          ...(descriptor.languages === undefined
            ? {}
            : { languages: Object.freeze([...descriptor.languages]) }),
          pricing: pricing === 'unknown' ? pricing : Object.freeze({ ...pricing }),
        }),
      );
    }
    const requirements = new Map(Object.entries(definition.models ?? {}));
    const routes = new Map(Object.entries(routing?.roles ?? {}));
    if (
      requirements.size !== routes.size ||
      [...requirements.keys()].some((role) => !routes.has(role))
    )
      throw failure('invalid');
    const providers = new Map<string, { readonly credential: boolean }>();
    for (const [role, route] of routes) {
      const needs = requirements.get(role);
      if (
        needs === undefined ||
        !record(route) ||
        !strings(route.providers) ||
        route.providers.length === 0 ||
        !strings(route.allow) ||
        !route.allow.every((destination) =>
          DESTINATIONS.includes(destination as DestinationClass),
        ) ||
        !Number.isInteger(route.maxTokens) ||
        route.maxTokens < 1 ||
        (route.maxCost !== undefined && !nonnegative(route.maxCost))
      )
        throw failure('invalid');
      let unknownPrice = false;
      for (const providerId of route.providers) {
        const descriptor = this.#providers.get(providerId);
        if (descriptor === undefined || !route.allow.includes(descriptor.destination))
          throw failure('invalid');
        unknownPrice ||= descriptor.pricing === 'unknown';
        providers.set(providerId, Object.freeze({ credential: descriptor.credential === true }));
      }
      if (unknownPrice !== (route.maxCost !== undefined)) throw failure('invalid');
      this.#roles.set(role, {
        requirements: Object.freeze({
          ...needs,
          ...(needs.requires === undefined ? {} : { requires: Object.freeze([...needs.requires]) }),
          ...(needs.languages === undefined
            ? {}
            : { languages: Object.freeze([...needs.languages]) }),
        }),
        route: Object.freeze({
          ...route,
          providers: Object.freeze([...route.providers]),
          allow: Object.freeze([...route.allow]),
        }),
      });
    }
    this.summary = Object.freeze({
      roles: Object.freeze([...this.#roles.keys()]),
      providers: Object.freeze(Object.fromEntries(providers)),
    });
  }

  dispose(): void {
    this.#disposed = true;
    for (const pending of this.#pending.values()) pending.controller.abort();
    this.#pending.clear();
    this.#answered.clear();
    this.#selected.clear();
  }

  async #decision(
    key: string,
    run: ModelRun,
    signal: AbortSignal,
    decide: (signal: AbortSignal) => boolean | Promise<boolean>,
    memory: 'answers' | 'refusals',
  ): Promise<boolean> {
    const answered = this.#answered.get(key);
    if (answered !== undefined) return answered;
    let pending = this.#pending.get(key);
    if (pending === undefined) {
      const entry: PendingDecision = {
        controller: new AbortController(),
        promise: Promise.resolve(false),
        waiters: 0,
        settled: false,
      };
      const remember = (answer: boolean): boolean => {
        if (
          this.#pending.get(key) === entry &&
          !entry.controller.signal.aborted &&
          (memory === 'answers' || !answer)
        )
          this.#answered.set(key, answer);
        return answer;
      };
      entry.promise = Promise.resolve()
        .then(() => decide(entry.controller.signal))
        .then(
          (answer) => {
            if (typeof answer !== 'boolean') {
              this.#report({ kind: 'model_failed', runId: run.runId });
              return memory === 'refusals' ? remember(false) : false;
            }
            return remember(answer);
          },
          (error) => {
            this.#report({ kind: 'model_failed', runId: run.runId, error });
            return memory === 'refusals' ? remember(false) : false;
          },
        )
        .finally(() => {
          entry.settled = true;
          if (this.#pending.get(key) === entry) this.#pending.delete(key);
        });
      this.#pending.set(key, entry);
      pending = entry;
    }
    pending.waiters++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      pending.waiters--;
      if (pending.waiters === 0 && !pending.settled) {
        if (this.#pending.get(key) === pending) this.#pending.delete(key);
        pending.controller.abort();
      }
    };
    signal.addEventListener('abort', release, { once: true });
    if (signal.aborted) release();
    try {
      return await waitForHostOrAbort(
        pending.promise,
        AbortSignal.any([signal, pending.controller.signal]),
      );
    } finally {
      signal.removeEventListener('abort', release);
      release();
    }
  }

  async #approval(
    role: string,
    destination: DestinationClass,
    route: ModelRoute,
    run: ModelRun,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (destination === 'in-browser') return true;
    return this.#decision(
      JSON.stringify(['consent', role, destination]),
      run,
      signal,
      (decisionSignal) => {
        const previous = this.#selected.get(role);
        return this.#consent === undefined
          ? false
          : this.#consent({
              role,
              destination,
              providers: Object.freeze(
                route.providers.filter(
                  (id) => this.#providers.get(id)?.destination === destination,
                ),
              ),
              ...(previous === undefined ? {} : { previous }),
              signal: decisionSignal,
            });
      },
      'answers',
    );
  }

  async #probe(
    role: string,
    providerId: string,
    run: ModelRun,
    signal: AbortSignal,
  ): Promise<ModelAvailability> {
    if (this.#availability === undefined) return { status: 'available' };
    const result = await waitForHostOrAbort(
      Promise.resolve()
        .then(() => this.#availability?.({ role, providerId, signal }))
        .then(
          (value): ModelAvailability => {
            if (record(value)) {
              if (value.status === 'available' || value.status === 'unavailable')
                return { status: value.status };
              if (
                value.status === 'downloadable' &&
                typeof value.siteStorage === 'boolean' &&
                (value.bytes === undefined ||
                  (typeof value.bytes === 'number' &&
                    Number.isSafeInteger(value.bytes) &&
                    value.bytes >= 0))
              ) {
                return {
                  status: 'downloadable',
                  siteStorage: value.siteStorage,
                  ...(value.bytes === undefined ? {} : { bytes: value.bytes }),
                };
              }
            }
            this.#report({ kind: 'model_failed', runId: run.runId });
            return { status: 'unavailable' };
          },
          (error): ModelAvailability => {
            this.#report({ kind: 'model_failed', runId: run.runId, error });
            return { status: 'unavailable' };
          },
        ),
      signal,
    );
    return result;
  }

  async #persist(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    this.#persistence ??= Promise.resolve()
      .then(() => globalThis.navigator?.storage?.persist?.())
      .then(
        (answer) => answer === true,
        () => false,
      );
    try {
      return await waitForHostOrAbort(this.#persistence, signal);
    } catch {
      return false;
    }
  }

  async #downloadApproval(
    role: string,
    providerId: string,
    availability: Extract<ModelAvailability, { status: 'downloadable' }>,
    run: ModelRun,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.#decision(
      JSON.stringify(['download', providerId]),
      run,
      signal,
      (decisionSignal) =>
        this.#download === undefined
          ? false
          : this.#download({
              role,
              providerId,
              signal: decisionSignal,
              ...(availability.bytes === undefined ? {} : { bytes: availability.bytes }),
              ...(availability.siteStorage ? { persist: () => this.#persist(decisionSignal) } : {}),
            }),
      'refusals',
    );
  }

  port(run: ModelRun): ModelPort {
    return {
      begin: async (role, options) => {
        const signal =
          options?.signal === undefined
            ? run.signal
            : AbortSignal.any([run.signal, options.signal]);
        const assertActive = (): void => {
          if (this.#disposed || signal.aborted || !run.active()) throw failure('cancelled');
        };
        assertActive();
        const compiled = this.#roles.get(role);
        if (compiled === undefined) throw failure('unavailable');
        const { route, requirements } = compiled;
        const requires = options?.requires;
        if (
          requires !== undefined &&
          (!strings(requires) || !requires.every((feature) => MODEL_FEATURES.includes(feature)))
        )
          throw failure('invalid');
        let denied = false;
        const refused = new Set<DestinationClass>();
        const allowed = (destination: DestinationClass): boolean => {
          if (!labelsAllow(this.#policy, run.labels, destination) || refused.has(destination)) {
            denied = true;
            return false;
          }
          return true;
        };
        const attempt = async (
          providerId: string,
          descriptor: ModelDescriptor,
        ): Promise<ModelCall | undefined> => {
          assertActive();
          const destination = descriptor.destination;
          if (!allowed(destination)) return undefined;
          if (!(await this.#approval(role, destination, route, run, signal))) {
            assertActive();
            refused.add(destination);
            denied = true;
            return undefined;
          }
          assertActive();
          if (!allowed(destination)) return undefined;
          const pricing = descriptor.pricing;
          const cost =
            pricing === 'unknown'
              ? (route.maxCost ?? 0)
              : route.maxTokens * Math.max(pricing.inputPerToken, pricing.outputPerToken);
          let reservation: ModelReservation;
          try {
            reservation = run.budget.reserveModel(route.maxTokens, cost);
          } catch (error) {
            if (error instanceof BudgetExceeded) run.failBudget(error.budget);
            throw error;
          }
          let credential: string | undefined;
          try {
            if (descriptor.credential === true) {
              try {
                const value = await waitForHostOrAbort(
                  Promise.resolve().then(() => this.#getCredential?.({ role, providerId })),
                  signal,
                );
                assertActive();
                if (typeof value !== 'string' || value.length === 0) throw failure('unavailable');
                credential = value;
              } catch {
                assertActive();
                this.#report({ kind: 'model_failed', runId: run.runId });
                throw failure('unavailable');
              }
            }
            assertActive();
            if (!labelsAllow(this.#policy, run.labels, destination)) {
              reservation.release();
              credential = undefined;
              denied = true;
              return undefined;
            }
            const selected = Object.freeze({ providerId, destination });
            this.#selected.set(role, selected);
            run.selectedRouteChanged(role, selected);
            assertActive();
            let settled = false;
            const settle = (usage?: ModelUsage): void => {
              if (settled) return;
              settled = true;
              if (!run.active()) return;
              const reported = !signal.aborted && validUsage(usage);
              const tokens = reported ? usage.inputTokens + usage.outputTokens : route.maxTokens;
              const charge =
                reported && pricing !== 'unknown'
                  ? usage.inputTokens * pricing.inputPerToken +
                    usage.outputTokens * pricing.outputPerToken
                  : cost;
              try {
                reservation.settle(tokens, charge);
              } catch (error) {
                if (error instanceof BudgetExceeded) run.failBudget(error.budget);
                else throw error;
              }
            };
            const call: ModelCall = Object.freeze({
              ...selected,
              ...(credential === undefined ? {} : { credential }),
              end: settle,
              fail: () => settle(),
            });
            credential = undefined;
            return call;
          } catch (error) {
            reservation.release();
            credential = undefined;
            throw error;
          }
        };
        const deferred: Array<{
          providerId: string;
          descriptor: ModelDescriptor;
          availability: ModelAvailability;
        }> = [];
        const seen = new Set<string>();
        let downloadSeen = false;
        for (const providerId of route.providers) {
          assertActive();
          if (seen.has(providerId)) continue;
          seen.add(providerId);
          const descriptor = this.#providers.get(providerId);
          if (
            descriptor === undefined ||
            requirements.requires?.some((feature) => !descriptor.features.includes(feature)) ||
            requires?.some((feature) => !descriptor.features.includes(feature)) ||
            requirements.languages?.some(
              (language) =>
                !descriptor.languages?.some(
                  (supported) => primary(supported) === primary(language),
                ),
            )
          )
            continue;
          if (!allowed(descriptor.destination)) continue;
          const availability = await this.#probe(role, providerId, run, signal);
          assertActive();
          if (!allowed(descriptor.destination) || availability.status === 'unavailable') continue;
          if (availability.status === 'downloadable') {
            if (descriptor.destination !== 'in-browser') continue;
            downloadSeen = true;
          }
          if (
            availability.status === 'downloadable' ||
            (downloadSeen && descriptor.destination !== 'in-browser')
          ) {
            deferred.push({ providerId, descriptor, availability });
            continue;
          }
          const call = await attempt(providerId, descriptor);
          if (call !== undefined) return call;
        }
        for (const { providerId, descriptor, availability } of deferred) {
          assertActive();
          if (!allowed(descriptor.destination)) continue;
          if (availability.status === 'downloadable') {
            if (!(await this.#downloadApproval(role, providerId, availability, run, signal))) {
              assertActive();
              denied = true;
              continue;
            }
            assertActive();
            const ready = await this.#probe(role, providerId, run, signal);
            assertActive();
            if (ready.status !== 'available') continue;
          }
          const call = await attempt(providerId, descriptor);
          if (call !== undefined) return call;
        }
        throw failure(denied ? 'denied' : 'unavailable');
      },
    };
  }
}
