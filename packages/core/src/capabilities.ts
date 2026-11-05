// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { AgentRef, EffectId, PrincipalScope, RunId } from './ids.js';
import type { DestinationClass } from './policy.js';
import type { Schema } from './schema.js';
import type { TraceHandle } from './trace.js';

/** A versioned capability name, for example `lessons.get@1`. A breaking change is a new version (ADR-0008). */
export type CapabilityName = `${string}@${number}`;

/** How the host classifies a capability. A tool's own claim is never accepted (brief §9.2). */
export type CapabilityKind = 'read' | 'write' | 'device' | 'ui';

/** A capability as a definition requests it (brief §13.2). A definition only requests; the host grants. */
export interface CapabilityRequest<Input extends Schema = Schema, Output extends Schema = Schema> {
  readonly input: Input;
  readonly output: Output;
  /** The kind the agent expects. The host binding's kind decides. */
  readonly kind: CapabilityKind;
}

/** Requested capabilities by versioned name. */
export type CapabilityRequests = { readonly [name: CapabilityName]: CapabilityRequest };

/** What a grant is tied to (brief §9.2). */
export type GrantScope = 'app' | 'principal' | 'instance' | 'run';

/**
 * Retry semantics that the host declares, never inferred from the name or the HTTP method (brief
 * §9.2, §12.3):
 *
 * - `none`: an unknown outcome fails with `outcome_unknown` and never re-invokes the binding;
 * - `idempotent`: repeating the call has no further effect;
 * - `idempotency-key`: the server dedupes calls by effect ID.
 *
 * With a recovery store, these policies govern replay of dispatched or unknown writes, not an
 * immediate retry loop. A succeeded receipt is reused without invoking the binding. Without a
 * store, core does not retry. No host reconciliation API exists yet: reconcile an unknown write
 * with the backend before a new session could repeat it; new sessions derive new effect IDs.
 */
export type RetryPolicy = 'none' | 'idempotent' | 'idempotency-key';

/** What the broker passes to a binding with each call. */
export interface CapabilityContext {
  /** Aborts on cancel or timeout. An abort does not prove that the server did nothing (brief §12.3). */
  readonly signal: AbortSignal;
  /**
   * Send this as the backend's idempotency key. With recovery, writes derive it from the session,
   * executor task scope, capability name and per-scope, per-name call ordinal. Re-executing a
   * pending task reuses its IDs; call order within each task must be deterministic. A new task
   * gets new IDs. Without a task scope, the resume interaction (or literal start) is the scope;
   * repeated unscoped starts in one session reuse IDs, so use a fresh session for a new operation.
   * Other calls use random IDs.
   */
  readonly effectId: EffectId;
  readonly runId: RunId;
  readonly principalScope: PrincipalScope;
  /** The calling agent, for attribution. It identifies the agent; it never authorizes (ADR-0012 A8). */
  readonly agent: AgentRef;
}

/**
 * A host binding: the host's implementation of one capability, with its policy (brief §9.2). The
 * broker validates the input before `invoke` and the output after it.
 */
export interface CapabilityBinding<Input = unknown, Output = unknown> {
  readonly kind: CapabilityKind;
  /** The final recipient of the arguments. Free-text arguments follow the data-label rule for it (ADR-0014). */
  readonly destination: DestinationClass;
  /** A finite timeout, in milliseconds. */
  readonly timeoutMs: number;
  /** The maximum number of concurrent calls. */
  readonly concurrency: number;
  readonly grantScope: GrantScope;
  /** `confirm`: every call needs a host-rendered confirmation bound to its arguments (ADR-0012 A5). */
  readonly approval: 'none' | 'confirm';
  readonly retry: RetryPolicy;
  /** A property, not a method, so a binding that needs more input than the schema gives fails to compile. */
  readonly invoke: (input: Input, context: CapabilityContext) => Promise<Output>;
}

/** Framework-neutral access to the current run's broker. */
export interface CapabilityPort {
  call(
    name: string,
    input: unknown,
    options?: {
      readonly signal?: AbortSignal;
      readonly parent?: TraceHandle;
      /** Opaque, stable executor task namespace for recovery write identity. */
      readonly effectScope?: string;
    },
  ): Promise<unknown>;
}

export interface HttpCapabilityOptions extends Omit<CapabilityBinding, 'invoke'> {
  readonly url: string;
  readonly method: 'GET' | 'DELETE' | 'POST' | 'PUT' | 'PATCH';
  readonly headers?: (context: CapabilityContext) => HeadersInit | Promise<HeadersInit>;
  readonly credentials?: RequestCredentials;
  readonly fetch?: typeof globalThis.fetch;
}

/** These headers attribute the calling agent and run; they never authorize a request. */
export function attributionHeaders(context: CapabilityContext): Readonly<Record<string, string>> {
  return {
    'X-Galaxie-Agent': `${context.agent.id}@${context.agent.version}`,
    'X-Galaxie-Run': context.runId,
  };
}
