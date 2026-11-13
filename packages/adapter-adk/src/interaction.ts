// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { BaseAgent, Event } from '@google/adk';
import { failure } from './errors.js';

type Content = NonNullable<Event['content']>;
type Part = NonNullable<Content['parts']>[number];
type FunctionCall = NonNullable<Part['functionCall']>;

/** ADK's reserved function-call names; the bundle does not export them. */
export const CONFIRMATION_CALL = 'adk_request_confirmation';
export const INPUT_CALL = 'adk_request_input';

/**
 * One call the run is waiting on, as the author's `interaction` and `resume` see it. Requests are
 * addressed by position: ADK's call IDs never reach author code, props or the user interface.
 */
export type AdkPendingRequest =
  /** A tool created with `requireConfirmation`; it has not run. */
  | {
      readonly kind: 'confirmation';
      readonly tool: string;
      readonly args: Readonly<Record<string, unknown>>;
      readonly hint?: string;
    }
  /** A `longRunning` tool returned its pending result; the real result arrives with the resume. */
  | {
      readonly kind: 'long-running';
      readonly tool: string;
      readonly args: Readonly<Record<string, unknown>>;
    };

/** What a resume decides for the request at the same position. */
export type AdkDecision =
  | { readonly confirmed: boolean }
  | { readonly response: Readonly<Record<string, unknown>> };

export interface AdkEntryOptions {
  readonly agent: BaseAgent;
  /** Interpret exact model strings as declared host roles in a host-owned agent tree. */
  readonly roleStrings?: true;
  /**
   * Builds the four-field display request (surface, view revision, component, props) for the
   * pending calls. Without it a run that pauses fails `unsupported`.
   */
  readonly interaction?: (requests: readonly AdkPendingRequest[]) => unknown;
  /**
   * Turns the user's action and payload into one decision per request, in order. The default
   * confirms on `approve` and denies on `deny` for confirmation requests only, and fails closed.
   */
  readonly resume?: (
    requests: readonly AdkPendingRequest[],
    action: string,
    payload: unknown,
  ) => readonly AdkDecision[];
}

export type AdkEntry = Readonly<AdkEntryOptions>;

const entries = new WeakSet<object>();

/** Wraps an agent with the author's pause handling; membership, not shape, marks an entry. */
export function defineAdkEntry(options: AdkEntryOptions): AdkEntry {
  if (
    typeof options !== 'object' ||
    options === null ||
    typeof options.agent !== 'object' ||
    options.agent === null ||
    (options.interaction !== undefined && typeof options.interaction !== 'function') ||
    (options.resume !== undefined && typeof options.resume !== 'function') ||
    (options.roleStrings !== undefined && options.roleStrings !== true)
  )
    throw failure('invalid');
  const entry: AdkEntry = Object.freeze({ ...options });
  entries.add(entry);
  return entry;
}

export function isAdkEntry(value: unknown): value is AdkEntry {
  return typeof value === 'object' && value !== null && entries.has(value);
}

/** One ADK call the run waits on: the function-response ID and name its answer must carry. */
export interface PausedCall {
  readonly id: string;
  readonly name: string;
  readonly request: AdkPendingRequest;
  /** For a confirmation: the gated call, which has no response until the confirmation is decided. */
  readonly gated?: { readonly id: string; readonly name: string };
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyArgs(value: unknown): Record<string, unknown> {
  return plain(value) ? structuredClone(value) : {};
}

function requestOf(call: FunctionCall): AdkPendingRequest {
  const args = copyArgs(call.args);
  // ADK hides `adk_request_input` calls and answers from the model of an LlmAgent: only workflow
  // node tools read them, and the agent tree cannot hold a workflow. The answer would be lost.
  if (call.name === INPUT_CALL) throw failure('unsupported');
  if (typeof call.name !== 'string' || call.name.length === 0) throw failure('invalid');
  return { kind: 'long-running', tool: call.name, args };
}

function confirmationOf(call: FunctionCall): PausedCall {
  const pinned: unknown = call.args?.['originalFunctionCall'];
  const confirmation: unknown = call.args?.['toolConfirmation'];
  if (
    typeof call.id !== 'string' ||
    !plain(pinned) ||
    typeof pinned['name'] !== 'string' ||
    pinned['name'].length === 0
  )
    throw failure('invalid');
  const hint = plain(confirmation) ? confirmation['hint'] : undefined;
  return {
    id: call.id,
    name: CONFIRMATION_CALL,
    request: {
      kind: 'confirmation',
      tool: pinned['name'],
      args: copyArgs(pinned['args']),
      ...(typeof hint === 'string' ? { hint } : {}),
    },
    ...(typeof pinned['id'] === 'string'
      ? { gated: { id: pinned['id'], name: pinned['name'] } }
      : {}),
  };
}

function pausedOf(call: FunctionCall): PausedCall {
  if (typeof call.id !== 'string' || typeof call.name !== 'string') throw failure('invalid');
  return { id: call.id, name: call.name, request: requestOf(call) };
}

const callsOf = (event: Event): FunctionCall[] =>
  (event.content?.parts ?? []).flatMap((part) =>
    part.functionCall === undefined ? [] : [part.functionCall],
  );

/**
 * Watches the events of one run for the point where ADK needs the user (KTD9). A confirmation
 * request ends the invocation by itself; a long-running tool pauses it only after the tool has
 * returned its pending result, before ADK asks the model about it.
 */
export class PauseTracker {
  /** Long-running calls of the latest tool turn that have no answer yet, by call ID. */
  readonly #flagged = new Map<string, FunctionCall>();
  #turn: FunctionCall[] = [];
  #calls: PausedCall[] | undefined;

  /** The calls the run now waits on, once `observe` has returned true. */
  get calls(): readonly PausedCall[] | undefined {
    return this.#calls;
  }

  /** True when long-running calls were issued and the run ended before their results arrived. */
  get unanswered(): boolean {
    return this.#calls === undefined && this.#flagged.size > 0;
  }

  /**
   * Returns true when this event is the one the run pauses on. Throws `unsupported` for a turn
   * ADK cannot resume faithfully: a confirmation beside a long-running call (their responses sit
   * in different events) or beside another call (ADK drops that call's result).
   */
  observe(event: Event): boolean {
    if (event.partial === true) return false;
    const calls = callsOf(event);
    const gates = calls.filter((call) => call.name === CONFIRMATION_CALL);
    if (gates.length > 0) {
      const confirmations = gates.map(confirmationOf);
      const gated = new Set(confirmations.map((entry) => entry.gated?.id));
      if (this.#flagged.size > 0 || this.#turn.some((call) => !gated.has(call.id)))
        throw failure('unsupported');
      this.#calls = confirmations;
      return true;
    }
    if (calls.length > 0) {
      this.#turn = calls;
      this.#flagged.clear();
      const flagged = new Set(event.longRunningToolIds ?? []);
      for (const call of calls)
        if (call.id !== undefined && flagged.has(call.id)) this.#flagged.set(call.id, call);
      return false;
    }
    // The next event after a turn with long-running calls is the one that carries their (possibly
    // empty) results; ADK would call the model about them next, so the run pauses here instead.
    if (this.#flagged.size === 0) return false;
    this.#calls = [...this.#flagged.values()].map(pausedOf);
    return true;
  }
}

/** The default resume: approve or deny every confirmation, nothing else. */
export function defaultResume(
  requests: readonly AdkPendingRequest[],
  action: string,
  payload: unknown,
): readonly AdkDecision[] {
  const indexes: unknown = plain(payload) ? payload['indexes'] : undefined;
  if (
    (action !== 'approve' && action !== 'deny') ||
    requests.some((request) => request.kind !== 'confirmation') ||
    !plain(payload) ||
    Object.keys(payload).length !== 1 ||
    !Array.isArray(indexes) ||
    indexes.length !== requests.length ||
    new Set(indexes).size !== requests.length ||
    !requests.every((_, index) => indexes.includes(index))
  )
    throw failure('invalid');
  return requests.map(() => ({ confirmed: action === 'approve' }));
}

/** Checks the decisions against the requests and returns the user message that answers them. */
export function answerOf(calls: readonly PausedCall[], decisions: unknown): Content {
  if (!Array.isArray(decisions) || decisions.length !== calls.length) throw failure('invalid');
  const parts: Part[] = calls.map((call, index) => {
    const decision: unknown = decisions[index];
    if (!plain(decision) || Object.keys(decision).length !== 1) throw failure('invalid');
    if (call.request.kind === 'confirmation') {
      if (typeof decision['confirmed'] !== 'boolean') throw failure('invalid');
      return {
        functionResponse: {
          id: call.id,
          name: call.name,
          response: { confirmed: decision['confirmed'] },
        },
      };
    }
    const response: unknown = decision['response'];
    if (!plain(response)) throw failure('invalid');
    let copy: Record<string, unknown>;
    try {
      copy = JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
    } catch {
      throw failure('invalid');
    }
    return { functionResponse: { id: call.id, name: call.name, response: copy } };
  });
  return { role: 'user', parts };
}
