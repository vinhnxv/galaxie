// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

declare const brand: unique symbol;

/** A value that only the runtime creates or derives, never one taken from model output (brief §8.2). */
type Branded<T, Name extends string> = T & { readonly [brand]: Name };

/** The host app namespace. */
export type AppId = string;

/** A user or an anonymous session. It is not a credential. */
export type PrincipalScope = string;

/** The shared app/principal identifier rule, matching IndexedDB storage. */
export function isValidScope(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

/** An agent definition ID, for example `galaxie.examples/english-tutor`. */
export type AgentId = string;

/** A UI region the host assigns, for example `lesson-main` (brief §11.2). */
export type SurfaceId = string;

/** One agent instance that the app manages. */
export type InstanceId = Branded<string, 'InstanceId'>;

/** One study session or conversation, mapped to an executor thread. */
export type SessionId = Branded<string, 'SessionId'>;

/** One run, from start until it succeeds, fails or is cancelled. It keeps its ID across waits and resumes. */
export type RunId = Branded<string, 'RunId'>;

/** One pending interaction: the engine's interrupt ID, or an ID derived from the checkpoint (ADR-0004). */
export type InteractionId = Branded<string, 'InteractionId'>;

/** Changes when the structure or content of an interaction changes (brief §11.4). */
export type ViewRevision = Branded<string, 'ViewRevision'>;

/** Identifies one external effect; it is also the effect's idempotency key (brief §12.3). */
export type EffectId = Branded<string, 'EffectId'>;

/** One host-only, single-use confirmation. Never exposed to the executor. */
export type ConfirmationId = Branded<string, 'ConfirmationId'>;

/** Correlates journal and trace events. */
export type EventId = Branded<string, 'EventId'>;

/** The fencing epoch of the owner tab (ADR-0009). */
export type Epoch = Branded<number, 'Epoch'>;

/** An agent definition: its ID, package version and content hash (brief §8.2). */
export interface AgentRef {
  readonly id: AgentId;
  readonly version: string;
  readonly hash: string;
}
