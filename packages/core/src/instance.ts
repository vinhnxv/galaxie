// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { CapabilityName } from './capabilities.js';
import type { ErrorInfo } from './errors.js';
import type { RunEvent } from './events.js';
import type { InstanceId, InteractionId, RunId, SessionId } from './ids.js';
import type {
  DispatchReceipt,
  InboxStatus,
  PendingInteraction,
  UserInteractionEvent,
} from './interactions.js';
import type { InstanceState, RunStatus } from './lifecycle.js';
import type { PublishedModelRoute } from './models.js';
import type { DataLabel } from './policy.js';

/** The current run, as a snapshot shows it. */
export interface RunSnapshot {
  readonly runId: RunId;
  readonly status: RunStatus;
  readonly labels: readonly DataLabel[];
  /** Set while the run waits for input; rebuilt from the checkpoint after a reload (ADR-0004). */
  readonly pending?: PendingInteraction;
  readonly submission?: { readonly interactionId: InteractionId; readonly status: InboxStatus };
  /** Set when the run failed. */
  readonly error?: ErrorInfo;
}

/** A read-only snapshot for rendering. The UI never changes graph state directly (brief §8.1). */
export interface AgentSnapshot<View> {
  readonly instanceId: InstanceId;
  readonly state: InstanceState;
  readonly prepareError?: ErrorInfo;
  readonly run?: RunSnapshot;
  /** Latest dispatched route per role; absent before the first call (ADR-0006). */
  readonly routes?: Readonly<Record<string, PublishedModelRoute>>;
  /** The agent's public projection of its state. */
  readonly view?: View;
}

/** The answer to a cancel request. A cancel does not undo a remote write that already happened (brief §8.3). */
export interface CancelReceipt {
  readonly runId: RunId;
  /** `cancelled`, or the terminal status the run reached first. */
  readonly status: RunStatus;
}

/** The agent instance a host works with (brief §14.1). At most one run is active per instance (brief §8.3). */
export interface AgentInstance<Input, View> {
  readonly instanceId: InstanceId;
  /** Host storage and the checkpointer must be scoped to the same app and principal. */
  readonly sessionId: SessionId;
  /** Downloads and device access go through host policy and consent. */
  prepare(): Promise<void>;
  /** Claims the slot synchronously; resolves when queued after validation, before executor events. */
  start(input: Input, options?: StartOptions): Promise<{ readonly runId: RunId }>;
  /** Rebuilds a waiting run from its checkpoint with fresh budgets and conservative labels. */
  restore(options?: StartOptions): Promise<{ readonly runId: RunId } | undefined>;
  /** Checks the event against the pending interrupt, then records it in the submission inbox (ADR-0004). */
  dispatch(event: UserInteractionEvent): Promise<DispatchReceipt>;
  cancel(runId: RunId): Promise<CancelReceipt>;
  /** Replays then follows the current run; a stale ID rejects the first next(). Break detaches the consumer. */
  events(runId: RunId): AsyncIterable<RunEvent>;
  /** Returns the same object until something changes, as `useSyncExternalStore` requires. */
  getSnapshot(): AgentSnapshot<View>;
  subscribe(listener: () => void): () => void;
  dispose(): Promise<void>;
}

export interface StartOptions {
  readonly grants?: readonly CapabilityName[];
}
