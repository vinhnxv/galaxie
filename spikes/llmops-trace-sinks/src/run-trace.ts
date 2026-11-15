// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Span, SpanProcessor } from '@opentelemetry/sdk-trace';

export interface RunTrace {
  traceId: string;
  runId: string;
  segment: number;
  sessionId: string;
}

export class RunTraceMap implements SpanProcessor {
  private readonly runs = new Map<string, Map<number, RunTrace>>();

  onStart(span: Span): void {
    const { attributes } = span;
    if (attributes['gen_ai.operation.name'] !== 'invoke_agent') return;
    const runId = attributes['galaxie.run.id'];
    const segment = attributes['galaxie.run.segment'];
    const sessionId = attributes['galaxie.session.id'];
    if (typeof runId !== 'string' || typeof segment !== 'number' || typeof sessionId !== 'string')
      return;
    const segments = this.runs.get(runId) ?? new Map<number, RunTrace>();
    segments.set(segment, { runId, segment, sessionId, traceId: span.spanContext().traceId });
    this.runs.set(runId, segments);
  }

  lookup(runId: string, segment: number): RunTrace | undefined {
    return this.runs.get(runId)?.get(segment);
  }

  hasRun(runId: string): boolean {
    return this.runs.has(runId);
  }

  entries(): RunTrace[] {
    return [...this.runs.values()].flatMap((segments) => [...segments.values()]);
  }

  onEnd(): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export class SessionCopy implements SpanProcessor {
  private readonly sessions = new Map<string, string>();

  onStart(span: Span): void {
    const traceId = span.spanContext().traceId;
    const rootSession = span.attributes['galaxie.session.id'];
    if (
      span.attributes['gen_ai.operation.name'] === 'invoke_agent' &&
      typeof rootSession === 'string'
    )
      this.sessions.set(traceId, rootSession);
    const sessionId = this.sessions.get(traceId);
    if (sessionId !== undefined) span.setAttribute('session.id', sessionId);
  }

  onEnd(): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {
    this.sessions.clear();
  }
}
