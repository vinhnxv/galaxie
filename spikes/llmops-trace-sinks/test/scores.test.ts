// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { RunTraceMap } from '../src/run-trace.js';
import { createScoreClient, scoreId } from '../src/scores.js';

const entry = { traceId: 'a'.repeat(32), runId: 'run-fixture', segment: 0, sessionId: 'session' };
test('score identity includes trace and name', () => {
  expect(scoreId(entry.traceId, 'quality')).toBe(`${entry.traceId}-quality`);
  expect(scoreId('b'.repeat(32), 'quality')).not.toBe(scoreId(entry.traceId, 'quality'));
  expect(scoreId(entry.traceId, 'other')).not.toBe(scoreId(entry.traceId, 'quality'));
});

test('unknown run and segment do not post', async () => {
  let calls = 0;
  const client = createScoreClient({
    authorization: 'fixture',
    fetch: async () => {
      calls++;
      return new Response(null, { status: 202 });
    },
  });
  const map = new RunTraceMap();
  expect(await client.scoreRun(map, 'missing', 0, 'quality', 1)).toEqual({
    status: 'unmapped',
    reason: 'run-not-seen',
  });
  const { runScenario } = await import('../src/scenarios.js');
  let seen = map;
  await runScenario('linear', {
    live: false,
    text: false,
    onHost(host) {
      seen = host.runTrace;
    },
  });
  const known = seen.entries()[0];
  expect(known).toBeDefined();
  expect(await client.scoreRun(seen, known?.runId ?? '', 9, 'quality', 1)).toEqual({
    status: 'unmapped',
    reason: 'segment-not-seen',
  });
  expect(calls).toBe(0);
});

test('transport and 5xx retry byte-identically, including two days later', async () => {
  const bodies: string[] = [];
  let now = new Date('2026-11-13T12:00:00Z');
  const client = createScoreClient({
    authorization: 'fixture',
    clock: () => now,
    fetch: async (_url, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new Error('transport');
      return new Response(null, { status: bodies.length === 2 ? 503 : 202 });
    },
  });
  expect(await client.post(entry, 'quality', 1)).toMatchObject({ status: 'posted' });
  now = new Date('2026-11-15T12:00:00Z');
  expect(await client.post(entry, 'quality', 0)).toMatchObject({ status: 'posted' });
  expect(new Set(bodies).size).toBe(1);
  expect(bodies[0]).toContain('2026-11-13T12:00:00.000Z');
});

test.each([207, 400, 401])('HTTP %s is not retried', async (status) => {
  let calls = 0;
  const client = createScoreClient({
    authorization: 'fixture',
    fetch: async () => {
      calls++;
      return new Response(null, { status });
    },
  });
  expect(await client.post(entry, 'quality', 1)).toEqual({
    status: 'rejected',
    httpStatus: status,
  });
  expect(calls).toBe(1);
});
