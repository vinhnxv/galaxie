// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type CapabilityPort,
  type ErrorCode,
  type GalaxieError,
  isGalaxieError,
  type ModelPort,
  type RunTrace,
  type TraceHandle,
} from '@galaxie/core';
import { failure } from './errors.js';

/** The pieces of one run that models and tools reach through the host. */
export interface RunServices {
  readonly capabilities: CapabilityPort;
  readonly models: ModelPort;
  readonly trace: RunTrace;
  readonly limits: { readonly steps: number };
  readonly signal: AbortSignal;
}

/**
 * Per-run state shared by the model and the tools. ADK catches errors thrown from either and turns
 * them into ordinary events, so the first fatal galaxie error is recorded here and the invocation is
 * aborted; the adapter reports the recorded error after the generator settles (KTD15).
 */
export class RunState {
  readonly #controller = new AbortController();
  readonly signal: AbortSignal;
  readonly capabilities: CapabilityPort;
  readonly models: ModelPort;
  readonly trace: RunTrace;
  readonly steps: number;
  readonly span: TraceHandle;
  #failure: GalaxieError | undefined;
  #modelCalls = 0;
  #calls = 0;

  constructor(services: RunServices, span: TraceHandle) {
    this.capabilities = services.capabilities;
    this.models = services.models;
    this.trace = services.trace;
    this.steps = services.limits.steps;
    this.span = span;
    this.signal = AbortSignal.any([services.signal, this.#controller.signal]);
  }

  get failure(): GalaxieError | undefined {
    return this.#failure;
  }

  /** Starts call IDs after the calls already stored in the session, so IDs stay unique across runs. */
  seedCallIds(existing: number): void {
    this.#calls = existing;
  }

  /** The next function-call ID, unique within the session across agents and runs. */
  takeCallId(): string {
    return `galaxie-${this.#calls++}`;
  }

  /** Counts one model call against `limits.steps`; the call that would exceed it fails. */
  countModelCall(): void {
    if (this.#modelCalls >= this.steps) throw this.fail(failure('budget_exceeded'));
    this.#modelCalls += 1;
  }

  /** Records the first fatal error, aborts the invocation and returns the recorded error. */
  fail(error: unknown, fallback: ErrorCode = 'unavailable'): GalaxieError {
    this.#failure ??= toGalaxieError(error, fallback, this.signal);
    this.#controller.abort();
    return this.#failure;
  }
}

/** A fixed-message galaxie error for any thrown value; cause text never reaches the result. */
export function toGalaxieError(
  error: unknown,
  fallback: ErrorCode,
  signal?: AbortSignal,
): GalaxieError {
  if (isGalaxieError(error)) return error;
  if (typeof error === 'object' && error !== null) {
    if ('invalidated' in error && error.invalidated === true) return failure('stale');
    if ('fenced' in error && error.fenced === true) return failure('fenced');
    if ('unrecoverable' in error && error.unrecoverable === true) return failure('unrecoverable');
  }
  // ADK refuses forged or altered history and mismatched confirmations by name; neither is retryable.
  for (let cause: unknown = error, depth = 0; cause instanceof Error && depth < 4; depth++) {
    if (cause.name === 'IntentMismatchError' || cause.name === 'ToolCallIntegrityError')
      return failure('invalid');
    cause = cause.cause;
  }
  return failure(signal?.aborted ? 'cancelled' : fallback);
}
