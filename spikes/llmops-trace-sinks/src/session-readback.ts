// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mlflowSessionQuery, observationsQuery, waitForReadback } from './readback.js';
import type { SessionsResult } from './scenarios.js';
import { inspectFeedback } from './score-readback.js';

export async function sessionReadback(result: SessionsResult): Promise<{
  sessions: {
    sessionId: string;
    oracleTraces: string[];
    oracleSpans: string[];
    langfuse: {
      traceIds: string[];
      spanIds: string[];
      missingSpanIds: string[];
      allObservationsGrouped: boolean;
      tracesGroupedByRoot: boolean;
    };
    mlflow: { traceIds: string[]; allObservationsGrouped: boolean; tracesGroupedByRoot: boolean };
  }[];
}> {
  assert.equal(result.runTrace.length, 6);
  assert.equal(result.spans.length, 18);
  assert.equal(result.credentialCalls, 6);
  for (const entry of result.runTrace)
    await waitForReadback(
      entry.traceId,
      result.spans
        .filter((span) => span.spanContext().traceId === entry.traceId)
        .map((span) => span.spanContext().spanId),
      inspectFeedback,
    );
  const sessions = [];
  const sessionIds = [...new Set(result.runTrace.map((entry) => entry.sessionId))];
  assert.equal(sessionIds.length, 2);
  const seen = { langfuse: new Set<string>(), mlflow: new Set<string>() };
  for (const sessionId of sessionIds) {
    const own = result.runTrace.filter((entry) => entry.sessionId === sessionId);
    const oracleTraces = own.map((entry) => entry.traceId);
    const ownSpans = result.spans.filter((span) =>
      oracleTraces.includes(span.spanContext().traceId),
    );
    const oracleSpans = ownSpans.map((span) => span.spanContext().spanId);
    const observations = await observationsQuery({ sessionId }, inspectFeedback);
    const traces = await mlflowSessionQuery(sessionId, inspectFeedback);
    for (const span of observations) {
      assert.ok(oracleSpans.includes(span.id), 'Langfuse session filter returned another session');
      assert.equal(span.sessionId, sessionId);
      assert.ok(!seen.langfuse.has(span.id), 'Langfuse sessions overlap');
      seen.langfuse.add(span.id);
    }
    for (const trace of traces) {
      assert.ok(
        oracleTraces.some((id) => `tr-${id}` === trace.trace_id),
        'MLflow session filter returned another session',
      );
      assert.equal(trace.trace_metadata?.['mlflow.trace.session'], sessionId);
      assert.ok(!seen.mlflow.has(trace.trace_id), 'MLflow sessions overlap');
      seen.mlflow.add(trace.trace_id);
    }
    const lfIds = ownSpans
      .filter((span) => observations.some((item) => item.id === span.spanContext().spanId))
      .map((span) => span.spanContext().spanId);
    const roots = ownSpans.filter((span) => span.name.startsWith('invoke_agent '));
    sessions.push({
      sessionId,
      oracleTraces,
      oracleSpans,
      langfuse: {
        traceIds: oracleTraces.filter((id) => observations.some((item) => item.traceId === id)),
        spanIds: lfIds,
        missingSpanIds: oracleSpans.filter((id) => !lfIds.includes(id)),
        allObservationsGrouped: observations.length === 9,
        tracesGroupedByRoot: roots.every((root) => lfIds.includes(root.spanContext().spanId)),
      },
      mlflow: {
        traceIds: oracleTraces.filter((id) =>
          traces.some((trace) => trace.trace_id === `tr-${id}`),
        ),
        allObservationsGrouped: traces.length === 3,
        tracesGroupedByRoot: traces.length === 3,
      },
    });
  }
  return { sessions };
}
