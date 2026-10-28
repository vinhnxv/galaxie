// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

/** Data-only instrumentation; executors never receive OpenTelemetry objects. */
export interface RunTrace {
  start(step: TraceStep, parent?: TraceHandle): TraceHandle;
}

export interface TraceHandle {
  /** Idempotent; calls after the run has ended do nothing. */
  end(result: TraceResult): void;
}

export type TraceStep =
  | { readonly kind: 'node'; readonly name: string; readonly step?: number }
  | { readonly kind: 'model'; readonly provider?: string; readonly model?: string };

export type TraceResult =
  | {
      readonly status: 'ok';
      readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
      readonly responseModel?: string;
    }
  | { readonly status: 'error'; readonly errorType?: string };
