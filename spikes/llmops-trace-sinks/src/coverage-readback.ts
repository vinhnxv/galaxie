// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import type { StoredSpan } from './coverage.js';
import { decodeValue, waitForReadback } from './readback.js';

export function scanMarkers(value: unknown, markers: readonly string[]): void {
  const text = JSON.stringify(value);
  for (const marker of markers)
    assert.ok(!text.includes(marker), `Trace content marker detected: ${marker}`);
}

interface CoverageReadback {
  backends: { langfuse: StoredSpan[]; mlflow: StoredSpan[] };
  controls: {
    rawResponsesScanned: boolean;
    rawResponseCount: number;
    spanIdsAndParentsMatch: boolean;
    matchedSpanCount: number;
  };
}

export async function coverageReadback(
  oracle: readonly ReadableSpan[],
  markers: readonly string[],
): Promise<CoverageReadback> {
  assert.ok(oracle.length > 0, 'Cannot read back an empty oracle');
  const raw = [];
  let rawResponseCount = 0;
  for (const traceId of new Set(oracle.map((span) => span.spanContext().traceId))) {
    const before = rawResponseCount;
    raw.push(
      await waitForReadback(
        traceId,
        oracle
          .filter((span) => span.spanContext().traceId === traceId)
          .map((span) => span.spanContext().spanId),
        (value) => {
          scanMarkers(value, markers);
          rawResponseCount++;
        },
      ),
    );
    assert.ok(rawResponseCount > before, 'No raw responses scanned for trace');
  }
  const observations = raw.flatMap((result) => result.observations);
  const spans = raw.flatMap((result) => result.spans);
  const hex = (id: string): string => Buffer.from(id, 'base64').toString('hex');
  const ids = oracle.map((span) => span.spanContext().spanId).sort();
  assert.deepEqual(
    observations.map((span) => span.id).sort(),
    ids,
    'Langfuse span set differs from oracle',
  );
  assert.deepEqual(
    spans.map((span) => hex(span.span_id)).sort(),
    ids,
    'MLflow span set differs from oracle',
  );
  const result: { langfuse: StoredSpan[]; mlflow: StoredSpan[] } = { langfuse: [], mlflow: [] };
  let matchedSpanCount = 0;
  for (const source of oracle) {
    const { spanId: id, traceId } = source.spanContext();
    const parentId = source.parentSpanContext?.spanId ?? null;
    const lf = observations.find((span) => span.id === id);
    const mf = spans.find((span) => hex(span.span_id) === id);
    assert.ok(lf && mf, `Missing stored span ${id}`);
    assert.equal(lf.traceId, traceId);
    assert.equal(hex(mf.trace_id), traceId);
    assert.equal(lf.parentObservationId || null, parentId, 'Langfuse parent differs from oracle');
    assert.equal(
      mf.parent_span_id ? hex(mf.parent_span_id) : null,
      parentId,
      'MLflow parent differs from oracle',
    );
    matchedSpanCount++;
    const lfAttributes = Object.fromEntries(
      Object.entries(lf.metadata)
        .filter(([key]) => key.startsWith('attributes.'))
        .map(([key, value]) => [key.slice(11), value]),
    );
    const mfAttributes = Object.fromEntries(
      mf.attributes.map(({ key, value }) => [key, decodeValue(value)]),
    );
    result.langfuse.push({
      id,
      traceId,
      parentId,
      name: lf.name,
      type: lf.type ?? null,
      kind: null,
      status: lf.level ?? '',
      attributes: lfAttributes,
      model: lf.model ?? null,
      usage: lf.usageDetails ?? {},
      input: lf.input ?? null,
      output: lf.output ?? null,
      startTime: lf.startTime,
      endTime: lf.endTime,
    });
    result.mlflow.push({
      id,
      traceId,
      parentId,
      name: mf.name,
      type:
        typeof mfAttributes['mlflow.spanType'] === 'string'
          ? mfAttributes['mlflow.spanType']
          : null,
      kind: mf.kind ?? null,
      status: mf.status?.code ?? 'STATUS_CODE_UNSET',
      attributes: mfAttributes,
      model:
        typeof mfAttributes['mlflow.llm.model'] === 'string'
          ? mfAttributes['mlflow.llm.model']
          : null,
      usage: mfAttributes['mlflow.chat.tokenUsage'] ?? {},
      input: mfAttributes['mlflow.spanInputs'] ?? null,
      output: mfAttributes['mlflow.spanOutputs'] ?? null,
      startTime: '<timestamp>',
      endTime: '<timestamp>',
    });
  }
  return {
    backends: result,
    controls: {
      rawResponsesScanned: rawResponseCount > 0,
      rawResponseCount,
      spanIdsAndParentsMatch: matchedSpanCount === oracle.length,
      matchedSpanCount,
    },
  };
}
