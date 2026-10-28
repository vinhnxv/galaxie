// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

/** Instance lifecycle (brief §8.3). A failed `prepare` returns to `created`, so the host can retry or dispose. */
export type InstanceState = 'created' | 'preparing' | 'ready' | 'disposing' | 'disposed';

/** Run status (brief §8.3, §14.1). */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'suspended'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** The states each state may move to. A state with no next state is terminal. */
export type Transitions<State extends string> = { readonly [From in State]: readonly State[] };

/** Instance transitions. Dispose works from every state before `disposing`, so a logout never waits for a download. */
export const INSTANCE_TRANSITIONS: Transitions<InstanceState> = {
  created: ['preparing', 'disposing'],
  preparing: ['ready', 'created', 'disposing'],
  ready: ['disposing'],
  disposing: ['disposed'],
  disposed: [],
};

/** Run transitions, as drawn in brief §8.3. */
export const RUN_TRANSITIONS: Transitions<RunStatus> = {
  /** Waits for the predecessor's iterator to settle; core fails the run after 10 seconds. */
  queued: ['running', 'failed', 'cancelled'],
  running: ['waiting_input', 'suspended', 'succeeded', 'failed', 'cancelled'],
  waiting_input: ['running', 'cancelled'],
  suspended: ['running', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};
