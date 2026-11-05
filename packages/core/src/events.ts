// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ErrorInfo } from './errors.js';
import type { EventId, RunId } from './ids.js';
import type { PendingInteraction } from './interactions.js';

/** What an executor reports during a run (brief §7.5). The runtime derives the run status from it. */
export type ExecutorEvent =
  /** Framework-specific data, passed by reference, delivered live and never journaled. */
  | {
      readonly type: 'stream';
      readonly executor: string;
      readonly path: readonly string[];
      readonly mode: string;
      readonly data: unknown;
    }
  // The graph waits for the user through an interrupt: the run becomes `waiting_input`.
  | { readonly type: 'interaction'; readonly interaction: PendingInteraction }
  // The graph finished: the run becomes `succeeded`.
  | { readonly type: 'output'; readonly output: unknown }
  // The graph failed: the run becomes `failed`.
  | { readonly type: 'error'; readonly error: ErrorInfo };

/** An executor event as the runtime journals it, with host-created identity and order (brief §8.2, §12.1). */
export type RunEvent = (ExecutorEvent | { readonly type: 'cancelled' }) & {
  readonly eventId: EventId;
  readonly runId: RunId;
  readonly sequence: number;
};
