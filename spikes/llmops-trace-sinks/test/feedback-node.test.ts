// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Host } from '../src/host.js';
import { normalize } from '../src/normalize.js';
import {
  observationsQuery,
  scoresQuery,
  scoreWindowMillis,
  waitForReadback,
  waitForScores,
} from '../src/readback.js';
import { runScenario, type ScenarioResult } from '../src/scenarios.js';
import { inspectFeedback, writeFeedback } from '../src/score-readback.js';
import { createScoreClient } from '../src/scores.js';
import { readEnv } from '../src/secrets.js';

const enabled = process.env['LLMOPS_STACK'] === '1';
let result: ScenarioResult;
let host: Host;
let posts = 0;
let now = new Date();
let client: ReturnType<typeof createScoreClient>;
const evidence: Record<string, unknown> = { demonstration: true, scoreWindowMillis };

beforeAll(async () => {
  if (!enabled) return;
  const reference = await fetch('http://127.0.0.1:3000/generated/api/openapi.yml', {
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  assert.equal(reference.status, 200);
  const schema = await reference.text();
  assert.ok(schema.includes('CreateScoresRequest:'));
  evidence['reference'] = {
    source: 'running Langfuse 4.80.0 /generated/api/openapi.yml',
    request: 'array',
    documentedStatus: 'generated response schema lists 200; description specifies 202 or 207',
    read: '/api/public/v3/scores?fields=subject',
  };
  result = await runScenario('interrupt-resume', {
    text: false,
    live: true,
    onHost(value) {
      host = value;
    },
  });
  assert.equal(result.runTrace.length, 2);
  for (const traceId of result.traceIds)
    await waitForReadback(
      traceId,
      result.spans
        .filter((span) => span.spanContext().traceId === traceId)
        .map((span) => span.spanContext().spanId),
      inspectFeedback,
    );
  now = new Date(Date.now() - 2 * 86_400_000);
  client = createScoreClient({
    authorization: readEnv()['LANGFUSE_AUTH_HEADER'] ?? '',
    clock: () => now,
    fetch: async (url, options) => {
      posts++;
      const response = await fetch(url, options);
      inspectFeedback(await response.clone().json());
      return response;
    },
  });
});

test.skipIf(!enabled)(
  'segment feedback associates and reposts without duplicates across dates',
  async () => {
    const records = [];
    for (const entry of result.runTrace) {
      const name = `segment-${entry.segment}`;
      const first = await client.scoreRun(host.runTrace, entry.runId, entry.segment, name, 1);
      expect(first.status).toBe('posted');
      const initial = await waitForScores({ traceId: entry.traceId, name }, 1, inspectFeedback);
      expect(initial).toHaveLength(1);
      expect(initial[0]?.subject).toEqual({ kind: 'trace', id: entry.traceId });
      expect(
        await client.scoreRun(host.runTrace, entry.runId, entry.segment, name, 1),
      ).toMatchObject({ status: 'posted' });
      now = new Date();
      expect(
        await client.scoreRun(host.runTrace, entry.runId, entry.segment, name, 0),
      ).toMatchObject({ status: 'posted' });
      const repeated = await waitForScores({ traceId: entry.traceId, name }, 1, inspectFeedback);
      expect(repeated).toHaveLength(1);
      expect(repeated[0]?.timestamp).toBe(initial[0]?.timestamp);
      expect(repeated[0]?.value).toBe(1);
      const other = result.runTrace.find((candidate) => candidate.segment !== entry.segment);
      assert.ok(other);
      expect(await scoresQuery({ traceId: other.traceId, name }, inspectFeedback)).toEqual([]);
      records.push({
        segment: entry.segment,
        traceId: entry.traceId,
        score: first,
        countAfterRepostAndLaterDateRetry: repeated.length,
        originalTimestampRetained: true,
        otherSegmentCount: 0,
      });
      now = new Date(Date.now() - 2 * 86_400_000);
    }
    evidence['segments'] = records;
  },
  scoreWindowMillis * 4 + 30_000,
);

test.skipIf(!enabled)(
  'fresh timestamp retry is recorded as a control',
  async () => {
    const entry = result.runTrace[0];
    assert.ok(entry);
    const backdated = createScoreClient({
      authorization: readEnv()['LANGFUSE_AUTH_HEADER'] ?? '',
      clock: () => new Date(Date.now() - 2 * 86_400_000),
    });
    expect((await backdated.post(entry, 'fresh-timestamp-control', 1)).status).toBe('posted');
    await waitForScores(
      { traceId: entry.traceId, name: 'fresh-timestamp-control' },
      1,
      inspectFeedback,
    );
    const fresh = createScoreClient({ authorization: readEnv()['LANGFUSE_AUTH_HEADER'] ?? '' });
    expect((await fresh.post(entry, 'fresh-timestamp-control', 0)).status).toBe('posted');
    const scores = await waitForScores(
      { traceId: entry.traceId, name: 'fresh-timestamp-control' },
      1,
      inspectFeedback,
    );
    evidence['freshTimestampControl'] = {
      status: 'observed',
      scores: scores.map(({ id, value, timestamp, subject }) => ({
        id,
        value,
        timestamp,
        subject,
      })),
      note: 'Immediate read after second acceptance; asynchronous later visibility is not measured.',
    };
  },
  scoreWindowMillis * 2 + 30_000,
);

test.skipIf(!enabled)(
  'a score accepted before ingestion links after buffered spans flush',
  async () => {
    let buffered: Host | undefined;
    const pending = await runScenario('linear', {
      text: false,
      live: true,
      flush: 'none',
      scheduledDelayMillis: 3_600_000,
      onHost(value) {
        buffered = value;
      },
    });
    assert.ok(buffered);
    assert.ok(pending.credentialCalls > 0);
    const entry = pending.runTrace[0];
    assert.ok(entry);
    try {
      expect(await observationsQuery({ traceId: entry.traceId }, inspectFeedback)).toEqual([]);
      expect((await client.post(entry, 'before-ingestion', 1)).status).toBe('posted');
      const before = await waitForScores(
        { traceId: entry.traceId, name: 'before-ingestion' },
        1,
        inspectFeedback,
      );
      expect(before).toHaveLength(1);
      expect(await observationsQuery({ traceId: entry.traceId }, inspectFeedback)).toEqual([]);
      await buffered.provider.forceFlush();
      const after = await waitForReadback(
        entry.traceId,
        pending.spans.map((span) => span.spanContext().spanId),
        inspectFeedback,
      );
      const linked = await scoresQuery(
        { traceId: entry.traceId, name: 'before-ingestion' },
        inspectFeedback,
      );
      expect(linked).toEqual(before);
      expect(linked[0]?.subject).toEqual({ kind: 'trace', id: entry.traceId });
      evidence['beforeIngestion'] = {
        observationsBeforeFlush: 0,
        observationsAfterFlush: after.observations.length,
        scoreCount: linked.length,
        subjectMatchesOracle: true,
        scoreUnchanged: true,
      };
    } finally {
      await buffered.provider.shutdown();
    }
  },
  scoreWindowMillis * 2 + 120_000,
);

test.skipIf(!enabled)('unmapped run and segment send no score request', async () => {
  const before = posts;
  const unseenRun = await client.scoreRun(host.runTrace, 'unseen-run', 0, 'quality', 1);
  const unseenSegment = await client.scoreRun(host.runTrace, result.runId, 99, 'quality', 1);
  expect(unseenRun).toEqual({ status: 'unmapped', reason: 'run-not-seen' });
  expect(unseenSegment).toEqual({ status: 'unmapped', reason: 'segment-not-seen' });
  expect(posts).toBe(before);
  evidence['unmapped'] = { unseenRun, unseenSegment, postRequests: posts - before };
});

afterAll(() => {
  if (enabled && result) writeFeedback('feedback-scores.json', normalize(evidence, result.spans));
});
