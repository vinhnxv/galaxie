// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { OutputSafetyOutcome, SelectedModelRoute } from './models.js';

/** Data-only instrumentation; executors never receive OpenTelemetry objects. */
export interface RunTrace {
  /** Adapters offer text only under the host's explicit development opt-in; core filters each attribute. */
  readonly recordsText: boolean;
  start(step: TraceStep, parent?: TraceHandle): TraceHandle;
}

export interface TraceHandle {
  /** Idempotent; calls after the run has ended do nothing. */
  end(result: TraceResult): void;
}

export type TraceStep =
  | { readonly kind: 'node'; readonly name: string; readonly step?: number }
  | {
      readonly kind: 'model';
      readonly input?: unknown;
      readonly provider?: string;
      readonly model?: string;
      /** Known before dispatch, including when the run closes before end callbacks (ADR-0006). */
      readonly route?: SelectedModelRoute;
    };

export type TraceResult =
  | {
      readonly status: 'ok';
      readonly output?: unknown;
      readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
      readonly responseModel?: string;
      readonly outputSafetyOutcome?: OutputSafetyOutcome;
      /** Final destination and provider for this model call (ADR-0006). */
      readonly route?: SelectedModelRoute;
    }
  | {
      readonly status: 'error';
      readonly errorType?: string;
      readonly outputSafetyOutcome?: OutputSafetyOutcome;
      /** Final destination and provider for this model call (ADR-0006). */
      readonly route?: SelectedModelRoute;
    };
