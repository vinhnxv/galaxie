// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ErrorInfo } from './errors.js';
import type { InstanceId, RunId } from './ids.js';
import type { DispatchReceipt, PendingInteraction, UserInteractionEvent } from './interactions.js';
import type { InstanceState, RunStatus } from './lifecycle.js';

/** The current run, as a snapshot shows it. */
export interface RunSnapshot {
  readonly runId: RunId;
  readonly status: RunStatus;
  /** Set while the run waits for input; rebuilt from the checkpoint after a reload (ADR-0004). */
  readonly pending?: PendingInteraction;
  /** Set when the run failed. */
  readonly error?: ErrorInfo;
}

/** A read-only snapshot for rendering. The UI never changes graph state directly (brief §8.1). */
export interface AgentSnapshot<View> {
  readonly instanceId: InstanceId;
  readonly state: InstanceState;
  readonly run?: RunSnapshot;
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
  /** Downloads and device access go through host policy and consent. */
  prepare(): Promise<void>;
  /** Resolves once the run is accepted. It never waits for the user. */
  start(input: Input): Promise<{ readonly runId: RunId }>;
  /** Checks the event against the pending interrupt, then records it in the submission inbox (ADR-0004). */
  dispatch(event: UserInteractionEvent): Promise<DispatchReceipt>;
  cancel(runId: RunId): Promise<CancelReceipt>;
  /** Returns the same object until something changes, as `useSyncExternalStore` requires. */
  getSnapshot(): AgentSnapshot<View>;
  subscribe(listener: () => void): () => void;
  dispose(): Promise<void>;
}
