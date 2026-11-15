// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { BrowserContext, Page } from 'playwright-core';
import { expect, test } from 'vitest';
import type { PageResult } from '../browser/main.js';
import { buildPage, csp, startPreview } from '../browser/vite.config.js';
import { canary, collectorUrl } from '../src/host.js';
import { normalize } from '../src/normalize.js';
import { decodeSpans } from '../src/oracle.js';
import {
  observationsQuery,
  scoresQuery,
  scoreWindowMillis,
  waitForReadback,
  waitForScores,
} from '../src/readback.js';
import {
  type CapturedRequest,
  captureRequest,
  scanBundle,
  scanRequests,
  scanResponses,
  summarizeRequests,
} from '../src/request-scan.js';
import type { RunTrace } from '../src/run-trace.js';
import { createScoreEndpoint, type ScoreReport } from '../src/score-endpoint.js';
import { inspectFeedback, writeFeedback } from '../src/score-readback.js';
import { createScoreClient } from '../src/scores.js';
import { readEnv } from '../src/secrets.js';

const enabled = process.env['LLMOPS_STACK'] === '1';

test.skipIf(!enabled)(
  'Chromium reports scores through the host and rejects crossed associations',
  async () => {
    const health = await fetch(collectorUrl, {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    await health.body?.cancel();
    expect(health.status).toBe(405);
    const env = readEnv();
    let upstreamPosts = 0;
    const scoreClient = createScoreClient({
      authorization: env['LANGFUSE_AUTH_HEADER'] ?? '',
      fetch: async (url, init) => {
        if (init?.method === 'POST') upstreamPosts++;
        const response = await fetch(url, init);
        inspectFeedback(await response.clone().json());
        return response;
      },
    });
    const endpoint = createScoreEndpoint({
      scoreClient,
      observations: (query) => observationsQuery(query, inspectFeedback),
    });
    const copies = await buildPage();
    const preview = await startPreview(endpoint);
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ headless: true });
    const resolvedOrigin = preview.resolvedUrls?.local[0];
    assert.ok(resolvedOrigin, 'Preview has no loopback origin');
    const origin: string = resolvedOrigin;
    const pendingRequests: Promise<CapturedRequest>[] = [];
    const wireRequests: Promise<CapturedRequest>[] = [];
    const responses: Promise<{ status: number; body: string }>[] = [];
    preview.httpServer.prependListener('request', (request: IncomingMessage) => {
      const url = new URL(request.url ?? '/', origin).href;
      const headers = Object.fromEntries(
        Object.entries(request.headers).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]],
        ),
      );
      wireRequests.push(
        new Promise((resolve, reject) => {
          const chunks: Buffer[] = [];
          request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          request.once('error', reject);
          request.once('end', () =>
            resolve({
              url,
              method: request.method ?? 'GET',
              headers,
              body: chunks.length ? Buffer.concat(chunks) : null,
            }),
          );
        }),
      );
    });
    const contexts: BrowserContext[] = [];
    async function pageFor(user?: string): Promise<Page> {
      const context = await browser.newContext();
      contexts.push(context);
      context.on('request', (request) => pendingRequests.push(captureRequest(request)));
      context.on('response', (response) => {
        if (new URL(response.url()).pathname === '/feedback/scores')
          responses.push(response.text().then((body) => ({ status: response.status(), body })));
      });
      if (user !== undefined) {
        const cookie = endpoint.issueSession(user);
        const value = cookie.split(';')[0]?.slice('llmops-session='.length);
        assert.ok(value);
        await context.addCookies([
          { name: 'llmops-session', value, url: origin, httpOnly: true, sameSite: 'Strict' },
        ]);
      }
      const page = await context.newPage();
      const response = await page.goto(origin);
      expect(response?.headers()['content-security-policy']).toBe(csp);
      await page.waitForFunction(() => window.llmops !== undefined);
      return page;
    }
    const report = async (
      page: Page,
      entry: Pick<RunTrace, 'runId' | 'traceId' | 'segment'>,
      value = 1,
    ): Promise<{ status: number; reason: string }> => {
      const body: ScoreReport = {
        runId: entry.runId,
        segment: entry.segment,
        traceId: entry.traceId,
        name: 'feedback',
        value,
      };
      return page.evaluate((body) => window.llmops.reportScore(body), body);
    };
    try {
      const alice = await pageFor('alice');
      const bob = await pageFor('bob');
      const anonymous = await pageFor();
      const aliceRun = await alice.evaluate(() =>
        window.llmops.run({
          name: 'interrupt-resume',
          text: false,
          exporter: 'proxy',
          flush: 'complete',
        }),
      );
      const bobRun = await bob.evaluate(() =>
        window.llmops.run({ name: 'linear', text: false, exporter: 'proxy', flush: 'complete' }),
      );
      const runs: PageResult[] = [aliceRun, bobRun];
      const spans = runs.flatMap((run) => decodeSpans(run.spans));
      for (const run of runs) {
        expect(run.credentialCalls).toBeGreaterThan(0);
        expect(run.exportErrors).toEqual({ flush: 0, shutdown: 0 });
        for (const traceId of run.traceIds)
          await waitForReadback(
            traceId,
            spans
              .filter((span) => span.spanContext().traceId === traceId)
              .map((span) => span.spanContext().spanId),
            inspectFeedback,
          );
      }
      const a = aliceRun.runTrace.find((entry) => entry.segment === 1);
      const b = bobRun.runTrace[0];
      assert.ok(a);
      assert.ok(b);
      const unauthenticated = await report(anonymous, a);
      expect(unauthenticated).toEqual({ status: 401, reason: 'unauthenticated' });
      const alicePosted = await report(alice, a);
      const bobPosted = await report(bob, b, 0.5);
      expect(upstreamPosts).toBe(2);
      expect(alicePosted).toEqual({ status: 200, reason: 'posted' });
      expect(bobPosted).toEqual({ status: 200, reason: 'posted' });
      const aliceScores = await waitForScores(
        { traceId: a.traceId, name: 'feedback' },
        1,
        inspectFeedback,
      );
      const bobScores = await waitForScores(
        { traceId: b.traceId, name: 'feedback' },
        1,
        inspectFeedback,
      );
      expect(aliceScores).toHaveLength(1);
      expect(bobScores).toHaveLength(1);
      expect(aliceScores[0]?.subject).toEqual({ kind: 'trace', id: a.traceId });
      expect(bobScores[0]?.subject).toEqual({ kind: 'trace', id: b.traceId });
      const wrongSegment = await report(alice, { ...a, segment: 0 });
      const ownedRunOtherTrace = await report(alice, { ...a, traceId: b.traceId });
      const confirmedOtherOwner = await report(bob, a);
      expect(wrongSegment).toEqual({ status: 404, reason: 'not-confirmed' });
      expect(ownedRunOtherTrace).toEqual({ status: 404, reason: 'not-confirmed' });
      expect(confirmedOtherOwner).toEqual({ status: 403, reason: 'forbidden' });
      // Deterministic: the 401, 404 and 403 reports never reached Langfuse.
      expect(upstreamPosts).toBe(2);
      expect(await scoresQuery({ traceId: a.traceId, name: 'feedback' }, inspectFeedback)).toEqual(
        aliceScores,
      );
      expect(await scoresQuery({ traceId: b.traceId, name: 'feedback' }, inspectFeedback)).toEqual(
        bobScores,
      );
      const repeat = await report(alice, a, 0);
      expect(repeat).toEqual({ status: 200, reason: 'posted' });
      expect(upstreamPosts).toBe(3);
      expect(await scoresQuery({ traceId: a.traceId, name: 'feedback' }, inspectFeedback)).toEqual(
        aliceScores,
      );
      const violations = [];
      for (const page of [alice, bob, anonymous])
        violations.push(...(await page.evaluate(() => window.llmops.violations)));
      expect(violations).toEqual([]);
      for (const context of contexts) await context.close();
      const requests = await Promise.all(pendingRequests);
      const wire = await Promise.all(wireRequests);
      const replies = await Promise.all(responses);
      expect(replies).toHaveLength(7);
      expect(
        requests.every((request) => new URL(request.url).origin === new URL(origin).origin),
      ).toBe(true);
      const files = readdirSync(new URL('../dist/page/', import.meta.url), {
        recursive: true,
        encoding: 'utf8',
      })
        .filter((file) => /\.(js|html|css)$/.test(file))
        .sort();
      expect(files.length).toBeGreaterThan(0);
      const chunks = files.map((file) =>
        readFileSync(new URL(`../dist/page/${file}`, import.meta.url)),
      );
      expect(scanBundle(chunks, env)).toEqual([]);
      for (const set of [requests, wire]) {
        const exports = set.filter(
          (request) =>
            new URL(request.url).pathname === '/otel/v1/traces' && request.method === 'POST',
        );
        const scores = set.filter(
          (request) => new URL(request.url).pathname === '/feedback/scores',
        );
        expect(exports.length).toBeGreaterThan(0);
        expect(scores).toHaveLength(7);
        expect(exports.every((request) => (request.body?.length ?? 0) > 0)).toBe(true);
        expect(scores.every((request) => (request.body?.length ?? 0) > 0)).toBe(true);
        expect(scanRequests(set, env, canary)).toEqual([]);
      }
      expect(
        scanResponses(
          replies.map((response) => response.body),
          env,
          canary,
        ),
      ).toEqual([]);
      const basic = env['LANGFUSE_AUTH_HEADER'];
      assert.ok(basic);
      expect(scanBundle([basic], env).length).toBeGreaterThan(0);
      expect(
        scanRequests(
          [
            {
              url: new URL('/feedback/scores', origin).href,
              method: 'POST',
              headers: {},
              body: Buffer.from(basic),
            },
          ],
          env,
          canary,
        ).length,
      ).toBeGreaterThan(0);
      expect(scanResponses([basic], env, canary).length).toBeGreaterThan(0);
      writeFeedback(
        'browser-feedback.json',
        normalize(
          {
            demonstration: true,
            browser: browser.version(),
            csp,
            sharedPackageCopies: copies,
            backendRootConfirmations: 3,
            waitedForBackendRootsBeforeReporting: true,
            reports: {
              unauthenticated,
              aliceSegmentOne: alicePosted,
              bobOwnTrace: bobPosted,
              wrongSegment,
              ownedRunOtherTrace,
              confirmedOtherOwner,
              repeat,
            },
            scores: {
              alice: aliceScores.map(({ id, name, value, subject }) => ({
                id,
                name,
                value,
                subject,
              })),
              bob: bobScores.map(({ id, name, value, subject }) => ({ id, name, value, subject })),
              unchangedAfterRejectedReports: true,
            },
            scans: {
              bundleFiles: files.map((file) =>
                file.replace(/assets\/index-[A-Za-z0-9_-]+\.js/g, 'assets/index-<hash>.js'),
              ),
              bundleHits: [],
              requestHits: [],
              wireHits: [],
              responseHits: [],
              bundlePositiveControlDetected: true,
              requestBodyPositiveControlDetected: true,
              responsePositiveControlDetected: true,
              requests: summarizeRequests(requests).map((summary) => ({
                ...summary,
                path: summary.path.replace(
                  /assets\/index-[A-Za-z0-9_-]+\.js/g,
                  'assets/index-<hash>.js',
                ),
              })),
              wireRequests: summarizeRequests(wire).map((summary) => ({
                ...summary,
                path: summary.path.replace(
                  /assets\/index-[A-Za-z0-9_-]+\.js/g,
                  'assets/index-<hash>.js',
                ),
              })),
              responseStatuses: replies.map((response) => response.status),
            },
            limitations: [
              'Collector acceptance precedes backend visibility; the host page must retry a 404 not-confirmed report after ingestion.',
              'First report wins: leaked run and trace IDs could be bound before their owner reports. Bind at run start through a host-issued grant for host-side hardening.',
              'Browser telemetry is client-controlled; backend confirmation establishes association consistency, not authenticity.',
              'Cookie sessions and bindings are in memory and are a local fixture, not real user authentication or durable authorization.',
            ],
            violations,
          },
          spans,
        ),
      );
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) =>
        preview.httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  scoreWindowMillis * 2 + 180_000,
);
