// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { beforeEach, expect, test, vi } from 'vitest';
import { coverageReadback } from '../src/coverage-readback.js';
import { waitForReadback } from '../src/readback.js';

vi.mock('../src/readback.js', async (original) => ({
  ...(await original<typeof import('../src/readback.js')>()),
  waitForReadback: vi.fn(),
}));

const id = '0123456789abcdef';
const traceId = id.repeat(2);
const oracle = [
  {
    name: 'root',
    attributes: {},
    spanContext: () => ({ spanId: id, traceId }),
  },
] as unknown as ReadableSpan[];

function readback(): Awaited<ReturnType<typeof waitForReadback>> {
  return {
    observations: [
      {
        id,
        traceId,
        name: 'root',
        parentObservationId: null,
        sessionId: null,
        metadata: {},
        startTime: 'start',
        endTime: 'end',
      },
    ],
    traces: [{ trace_id: traceId }],
    spans: [
      {
        span_id: Buffer.from(id, 'hex').toString('base64'),
        trace_id: Buffer.from(traceId, 'hex').toString('base64'),
        name: 'root',
        attributes: [],
        start_time_unix_nano: 1,
        end_time_unix_nano: 2,
      },
    ],
  };
}

beforeEach(() => {
  vi.mocked(waitForReadback).mockReset();
});

test('coverage controls count inspected raw responses and matched oracle spans', async () => {
  vi.mocked(waitForReadback).mockImplementation(async (_trace, _ids, inspect) => {
    inspect?.({ unprojected: 'first response' });
    inspect?.({ unprojected: 'second response' });
    return readback();
  });
  const result = await coverageReadback(oracle, ['marker']);
  expect(result.controls).toEqual({
    rawResponsesScanned: true,
    rawResponseCount: 2,
    spanIdsAndParentsMatch: true,
    matchedSpanCount: 1,
  });
  expect(result.backends.langfuse.map((span) => span.id)).toEqual([id]);
  expect(result.backends.mlflow[0]?.status).toBe('STATUS_CODE_UNSET');
});

test('coverage refuses readback that bypasses raw inspection', async () => {
  vi.mocked(waitForReadback).mockResolvedValue(readback());
  await expect(coverageReadback(oracle, ['marker'])).rejects.toThrow('No raw responses scanned');
});

test('coverage scans unprojected responses and rejects changed parent links', async () => {
  vi.mocked(waitForReadback).mockImplementation(async (_trace, _ids, inspect) => {
    inspect?.({ unprojected: 'marker' });
    return readback();
  });
  await expect(coverageReadback(oracle, ['marker'])).rejects.toThrow('Trace content marker');
  const changed = readback();
  if (changed.observations[0]) changed.observations[0].parentObservationId = 'other-parent';
  vi.mocked(waitForReadback).mockImplementation(async (_trace, _ids, inspect) => {
    inspect?.({ clean: true });
    return changed;
  });
  await expect(coverageReadback(oracle, ['marker'])).rejects.toThrow('Langfuse parent differs');
});
