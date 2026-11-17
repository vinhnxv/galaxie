// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { evaluateSessions } from '../src/evaluate.js';
import type { Host } from '../src/host.js';
import { normalize } from '../src/normalize.js';
import {
  observationsQuery,
  scoresQuery,
  scoreWindowMillis,
  waitForReadback,
  waitForScores,
} from '../src/readback.js';
import {
  runScenario,
  runSessions,
  type ScenarioResult,
  type SessionsResult,
} from '../src/scenarios.js';
import { inspectFeedback, writeFeedback } from '../src/score-readback.js';
import { createScoreClient, scoreId } from '../src/scores.js';
import { readEnv } from '../src/secrets.js';
import { sessionReadback } from '../src/session-readback.js';

const enabled = process.env['LLMOPS_STACK'] === '1';
let result: ScenarioResult;
let host: Host;
let posts = 0;
// Captured once so a run that crosses UTC midnight compares against the same day.
const backdatedDate = new Date(Date.now() - 2 * 86_400_000);
let client: ReturnType<typeof createScoreClient>;
const evidence: Record<string, unknown> = { demonstration: true, scoreWindowMillis };
const sessionRuns: SessionsResult[] = [];

test.skipIf(!enabled)(
  'session filters measure root-only and copied attributes in both backends',
  async () => {
    const phases = [];
    for (const [sessionCopy, text] of [
      [false, false],
      [true, false],
      [true, true],
    ] as const) {
      const result = await runSessions({ live: true, sessionCopy, text });
      sessionRuns.push(result);
      const measured = await sessionReadback(result);
      phases.push({
        phase: !sessionCopy ? 'collector-only' : text ? 'processor-text' : 'processor',
        text,
        sessionCopy,
        ...measured,
      });
      writeFeedback(
        'sessions.json',
        normalize(
          { demonstration: true, phases },
          sessionRuns.flatMap((item) => item.spans),
        ),
      );
    }
    // Positive controls and pinned outcomes: every phase must return rows for both
    // sessions (so an empty readback cannot pass), and the recorded findings are asserted.
    for (const phase of phases) {
      expect(phase.sessions).toHaveLength(2);
      for (const session of phase.sessions) {
        expect(session.oracleTraces).toHaveLength(3);
        expect(session.oracleSpans).toHaveLength(9);
        expect(session.langfuse.traceIds).toHaveLength(3);
        expect(session.langfuse.tracesGroupedByRoot).toBe(true);
        expect(session.mlflow.tracesGroupedByRoot).toBe(true);
        // Langfuse groups all nine observations only when child spans carry the attribute.
        expect(session.langfuse.allObservationsGrouped).toBe(phase.sessionCopy);
        expect(session.langfuse.missingSpanIds).toHaveLength(phase.sessionCopy ? 0 : 6);
      }
    }
    const grouped = (
      phase: Awaited<ReturnType<typeof sessionReadback>> | undefined,
      backend: 'langfuse' | 'mlflow',
    ): boolean =>
      phase?.sessions.every((session) =>
        backend === 'langfuse'
          ? session.langfuse.allObservationsGrouped && session.langfuse.tracesGroupedByRoot
          : session.mlflow.tracesGroupedByRoot,
      ) ?? false;
    writeFeedback(
      'sessions.json',
      normalize(
        {
          demonstration: true,
          phases,
          rootOnlySuffices: {
            langfuse: grouped(phases[0], 'langfuse'),
            mlflow: grouped(phases[0], 'mlflow'),
          },
          fullyGroupedWithProcessor: {
            langfuse: grouped(phases[1], 'langfuse'),
            mlflow: grouped(phases[1], 'mlflow'),
          },
        },
        sessionRuns.flatMap((item) => item.spans),
      ),
    );
  },
);

test.skipIf(!enabled)(
  'MLflow evaluates every stored trace with deterministic code scorers in both text modes',
  async () => {
    const variants = [];
    for (const result of sessionRuns.slice(1)) {
      const expected = result.runTrace.map((entry) => `tr-${entry.traceId}`);
      expect(expected).toHaveLength(6);
      const evaluation = await evaluateSessions(
        [...new Set(result.runTrace.map((entry) => entry.sessionId))],
        expected.length,
      );
      expect(evaluation.mlflowVersion).toBe('3.18.0');
      expect([...evaluation.traceIds].sort()).toEqual([...expected].sort());
      expect(evaluation.evaluateRows).toBe(6);
      expect(evaluation.rows).toHaveLength(6);
      expect(evaluation.nonNullCounts).toEqual({
        chat_usage_total: 6,
        chat_text_present: 6,
        root_io_present: 6,
      });
      expect(evaluation.rows.map((row) => row.traceId).sort()).toEqual([...expected].sort());
      expect(evaluation.rootIO.map((row) => row.traceId).sort()).toEqual([...expected].sort());
      for (const row of evaluation.rootIO) {
        expect(row.requestPresent).toBe(false);
        expect(row.responsePresent).toBe(false);
      }
      for (const row of evaluation.rows) {
        const traceId = row.traceId.replace(/^tr-/, '');
        const usage = result.spans
          .filter(
            (span) =>
              span.spanContext().traceId === traceId &&
              span.attributes['gen_ai.operation.name'] === 'chat',
          )
          .reduce(
            (sum, span) =>
              sum +
              Number(span.attributes['gen_ai.usage.input_tokens'] ?? 0) +
              Number(span.attributes['gen_ai.usage.output_tokens'] ?? 0),
            0,
          );
        expect(usage).toBe(5);
        expect(row.scores.chat_usage_total).toBe(usage);
        expect(row.scores.chat_text_present).toBe(result.text);
        const root = evaluation.rootIO.find((root) => root.traceId === row.traceId);
        assert.ok(root);
        expect(row.scores.root_io_present).toBe(root.requestPresent && root.responsePresent);
      }
      // Oracle check: the premise of the root-I/O finding is that the instrumented root spans
      // themselves carry no input or output attributes, independent of what MLflow shows.
      const roots = result.spans.filter((span) => span.name.startsWith('invoke_agent '));
      expect(roots).toHaveLength(6);
      for (const root of roots)
        expect(
          Object.keys(root.attributes).filter((key) =>
            /(^|\.)(input|output)(\.|$)|messages/.test(key),
          ),
        ).toEqual([]);
      const byOracle = <T extends { traceId: string }>(rows: T[]): T[] =>
        [...rows].sort((a, b) => expected.indexOf(a.traceId) - expected.indexOf(b.traceId));
      variants.push({
        text: result.text,
        ...evaluation,
        traceIds: expected,
        rootIO: byOracle(evaluation.rootIO),
        rows: byOracle(evaluation.rows),
        rootIOObservation:
          'Root request and response are empty because invoke_agent spans carry no input or output attributes (asserted on the in-memory span oracle); chat_usage_total and chat_text_present still return one value per trace.',
      });
    }
    expect(variants).toHaveLength(2);
    writeFeedback(
      'mlflow-evaluation.json',
      normalize(
        { demonstration: true, scorers: 'deterministic code only', variants },
        sessionRuns.slice(1).flatMap((result) => result.spans),
      ),
    );
  },
);

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
  client = createScoreClient({
    authorization: readEnv()['LANGFUSE_AUTH_HEADER'] ?? '',
    clock: () => backdatedDate,
    fetch: async (url, options) => {
      posts++;
      const response = await fetch(url, options);
      inspectFeedback(await response.clone().json());
      return response;
    },
  });
});

test.skipIf(!enabled)(
  'segment feedback associates, and a stored-payload repost keeps one score',
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
      // The client retains the first payload; later calls resend it unchanged whatever the
      // clock or the new value say, and report unchanged for a different requested value.
      expect(
        await client.scoreRun(host.runTrace, entry.runId, entry.segment, name, 0),
      ).toMatchObject({ status: 'unchanged' });
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
        countAfterStoredPayloadRepost: repeated.length,
        originalTimestampRetained: true,
        otherSegmentCount: 0,
      });
    }
    evidence['segments'] = records;
  },
  scoreWindowMillis * 4 + 30_000,
);

test.skipIf(!enabled)(
  'fresh timestamp retry is measured against a duplicate-visibility control',
  async () => {
    const entry = result.runTrace[0];
    assert.ok(entry);
    const name = 'fresh-timestamp-control';
    const authorization = readEnv()['LANGFUSE_AUTH_HEADER'] ?? '';
    const backdated = createScoreClient({
      authorization,
      clock: () => backdatedDate,
    });
    expect((await backdated.post(entry, name, 1)).status).toBe('posted');
    await waitForScores({ traceId: entry.traceId, name }, 1, inspectFeedback);
    // Positive control: a second row with the same trace and name but another ID must be
    // visible to this readback as a separate row, so a hidden duplicate cannot go unnoticed.
    const extra = await fetch('http://127.0.0.1:3000/api/public/scores', {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          id: `${entry.traceId}-${name}-extra`,
          traceId: entry.traceId,
          name,
          value: 2,
          dataType: 'NUMERIC',
          timestamp: backdatedDate.toISOString(),
        },
      ]),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    await extra.body?.cancel();
    expect(extra.status).toBe(202);
    const control = await waitForScores({ traceId: entry.traceId, name }, 2, inspectFeedback);
    expect(control.map((score) => score.value).sort()).toEqual([1, 2]);
    // Measurement: resend the same ID with a payload dated today.
    const fresh = createScoreClient({ authorization });
    expect((await fresh.post(entry, name, 0)).status).toBe('posted');
    await waitForScores({ traceId: entry.traceId, name }, 1, inspectFeedback, (scores) =>
      scores.some((score) => score.value === 0),
    );
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    const settled = await scoresQuery({ traceId: entry.traceId, name }, inspectFeedback);
    const sameId = settled.filter((score) => score.id === scoreId(entry.traceId, name));
    expect(sameId.length).toBeGreaterThan(0);
    expect(sameId.some((score) => score.value === 0)).toBe(true);
    evidence['freshTimestampControl'] = {
      status: 'observed',
      duplicateVisibilityControl: { rowsVisibleWithDistinctId: control.length },
      sameIdRowsAfterFreshDateResend: sameId.length,
      sameIdValues: sameId.map((score) => score.value).sort(),
      note: 'Rows are read after a 30 second settle. The control shows distinct IDs are visible as separate rows; the same-ID count is the observed backend behavior for a resend dated on a later day.',
    };
    for (const segment of result.runTrace) {
      const retained = await scoresQuery(
        { traceId: segment.traceId, name: `segment-${segment.segment}` },
        inspectFeedback,
      );
      expect(retained).toHaveLength(1);
      expect(retained[0]?.value).toBe(1);
      expect(retained[0]?.timestamp.slice(0, 10)).toBe(backdatedDate.toISOString().slice(0, 10));
    }
  },
  scoreWindowMillis * 4 + 60_000,
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
