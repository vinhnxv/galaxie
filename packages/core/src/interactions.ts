// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ErrorInfo } from './errors.js';
import type { InstanceId, InteractionId, RunId, SurfaceId, ViewRevision } from './ids.js';

/** A component catalog, for example `education/v1` (brief §11.2). */
export type CatalogId = `${string}/v${number}`;

/** A catalog component, for example `education.Quiz/v1` (ADR-0007). */
export type ComponentId = `${string}.${string}/v${number}`;

/** The UI a definition needs. The host reports what it supports before a run (brief §11.2). */
export interface UiRequirements {
  readonly catalog: CatalogId;
  /** Component names in the catalog, for example `Quiz`. */
  readonly components: readonly string[];
  readonly surfaces: readonly SurfaceId[];
}

/**
 * An interaction waiting for the user. The graph builds it deterministically, and the host reads it
 * from the checkpoint interrupt, including after a reload (ADR-0004).
 */
export interface PendingInteraction {
  readonly interactionId: InteractionId;
  readonly surfaceId: SurfaceId;
  readonly viewRevision: ViewRevision;
  readonly component: ComponentId;
  /** Validated against the registry's props schema before rendering (ADR-0007). */
  readonly props: unknown;
}

/** A user event. Every identity field is checked against the pending interrupt (brief §12.2). */
export interface UserInteractionEvent {
  readonly instanceId: InstanceId;
  readonly runId: RunId;
  readonly interactionId: InteractionId;
  readonly surfaceId: SurfaceId;
  readonly viewRevision: ViewRevision;
  /** A registered action name. Action labels and confirmation text come from the registry (ADR-0007). */
  readonly action: string;
  readonly payload: unknown;
}

/** The answer to a dispatched event. `accepted` means it is durable in the submission inbox (ADR-0004). */
export type DispatchReceipt =
  | { readonly status: 'accepted'; readonly interactionId: InteractionId }
  | { readonly status: 'rejected'; readonly error: ErrorInfo };

/** Submission inbox status. A consumed entry is the receipt (brief §12.1). */
export type InboxStatus = 'accepted' | 'consumed';
