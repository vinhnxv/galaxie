// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from 'playwright-core';
import { expect, test } from 'vitest';
import { assertSpanTree } from '../../../packages/core/test/span-tree.js';
import type { PageOptions, PageResult, Violation } from '../browser/main.js';
import { buildPage, csp, startPreview } from '../browser/vite.config.js';
import { canary, collectorUrl } from '../src/host.js';
import { compareLanes, laneSpecificAttributes } from '../src/lane-compare.js';
import { decodeSpans } from '../src/oracle.js';
import { readBack } from '../src/readback.js';
import {
  type CapturedRequest,
  captureRequest,
  scanBundle,
  scanRequests,
  summarizeRequests,
} from '../src/request-scan.js';
import { scenarioReadback } from '../src/scenario-readback.js';
import type { ScenarioResult } from '../src/scenarios.js';
import { readEnv } from '../src/secrets.js';

if (process.env['LLMOPS_STACK'] !== '1')
  console.info('Chromium page live checks skipped; run pnpm run browser-host.');

const folder = new URL('../results/', import.meta.url);
function writeResult(name: string, value: unknown): void {
  const serialized = JSON.stringify(value, null, 2);
  const formatted = execFileSync(
    fileURLToPath(new URL('../../../node_modules/.bin/biome', import.meta.url)),
    ['format', '--stdin-file-path', `results/${name}`],
    {
      input: `${name === 'browser-evidence.json' ? serialized.replace(/assets\/index-[A-Za-z0-9_-]+\.js/g, 'assets/index-<hash>.js') : serialized}\n`,
      encoding: 'utf8',
    },
  );
  writeFileSync(new URL(name, folder), formatted);
}
function decode(result: PageResult): ScenarioResult {
  const decoded = { ...result, spans: decodeSpans(result.spans) };
  expect(decoded.credentialCalls).toBeGreaterThan(0);
  for (const traceId of decoded.traceIds)
    assertSpanTree(
      decoded.spans.filter((span) => span.spanContext().traceId === traceId),
      decoded.text ? { text: 'allowed' } : undefined,
    );
  return decoded;
}
function inspect(body: unknown): void {
  assert.ok(
    !JSON.stringify(body).includes(canary),
    'Credential canary appeared in complete backend response',
  );
}

// Poll the whole window: a zero count at the first read is not absence evidence.
async function observe(
  result: ScenarioResult,
  milliseconds: number,
  absent = false,
): Promise<{ langfuse: number; mlflow: number }> {
  assert.ok(result.credentialCalls > 0, 'Credential path was not exercised');
  const ids = new Set(result.spans.map((span) => span.spanContext().spanId));
  const seen = { langfuse: new Set<string>(), mlflow: new Set<string>() };
  const deadline = Date.now() + milliseconds;
  let successfulReads = 0;
  let lastError: unknown;
  do {
    try {
      for (const traceId of result.traceIds) {
        const back = await readBack(traceId, inspect);
        if (absent) {
          assert.equal(back.observations.length, 0, 'CSP-blocked trace reached Langfuse');
          assert.equal(back.traces.length, 0, 'CSP-blocked trace reached MLflow');
          assert.equal(back.spans.length, 0, 'CSP-blocked spans reached MLflow');
        }
        for (const span of back.observations) if (ids.has(span.id)) seen.langfuse.add(span.id);
        for (const span of back.spans) {
          const id = Buffer.from(span.span_id, 'base64').toString('hex');
          if (ids.has(id)) seen.mlflow.add(id);
        }
      }
      successfulReads++;
      lastError = undefined;
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      lastError = error;
    }
    if (Date.now() < deadline) await setTimeout(500);
  } while (Date.now() < deadline);
  assert.ok(successfulReads > 0, 'No successful backend reads in observation window');
  if (lastError) throw lastError;
  return { langfuse: seen.langfuse.size, mlflow: seen.mlflow.size };
}

async function openPage(context: BrowserContext, origin: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => window.llmops !== undefined);
  return page;
}
async function run(page: Page, options: PageOptions): Promise<ScenarioResult> {
  return decode(await page.evaluate((options) => window.llmops.run(options), options));
}

test.skipIf(process.env['LLMOPS_STACK'] !== '1')(
  'built Chromium page exports, matches Node, and measures CSP and teardown',
  async () => {
    // Fail before starting a browser when the stack is stopped.
    const health = await fetch(collectorUrl, {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    await health.body?.cancel();
    expect(health.status).toBe(405);
    const env = readEnv();
    assert.ok(env['MLFLOW_EXPERIMENT_ID'], 'Stack is up but the MLflow experiment ID is empty');
    const copies = await buildPage();
    expect(copies).toEqual({
      '@opentelemetry/api': 1,
      '@langchain/core': 1,
      '@langchain/langgraph': 1,
    });
    const preview = await startPreview();
    let browser:
      | Awaited<ReturnType<typeof import('playwright-core')['chromium']['launch']>>
      | undefined;
    try {
      const { chromium } = await import('playwright-core');
      try {
        browser = await chromium.launch({ headless: true });
      } catch (cause) {
        throw new Error(
          'Chromium could not start; install the matching shell once with pnpm exec playwright-core install --only-shell chromium',
          { cause },
        );
      }
      const origin = preview.resolvedUrls?.local[0];
      assert.ok(origin, 'Preview has no loopback URL');
      const wireRequests: Promise<CapturedRequest>[] = [];
      preview.httpServer.prependListener('request', (request: IncomingMessage) => {
        const url = new URL(request.url ?? '/', origin).href;
        const method = request.method ?? 'GET';
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
            const finish = (): void =>
              resolve({
                url,
                method,
                headers,
                body: chunks.length === 0 ? null : Buffer.concat(chunks),
              });
            request.once('end', finish);
            request.once('aborted', finish);
          }),
        );
      });
      const context = await browser.newContext();
      const pendingRequests: Promise<CapturedRequest>[] = [];
      const capturedViolations: Violation[] = [];
      const consoleErrors: string[] = [];
      const normalizeUrl = (text: string): string =>
        text
          .replaceAll(collectorUrl, '<collector-origin>/v1/traces')
          .replaceAll(new URL(origin).origin, '<page-origin>');
      context.on('request', (request) => {
        pendingRequests.push(captureRequest(request));
      });
      context.on('page', (page) => {
        page.on('console', (message) => {
          if (
            message.type() === 'error' &&
            /Content Security Policy|violates|Refused/.test(message.text())
          )
            consoleErrors.push(normalizeUrl(message.text()));
        });
      });
      const collectViolations = async (page: Page, proxied: boolean): Promise<Violation[]> => {
        const violations = await page.evaluate(() => window.llmops.violations);
        if (proxied)
          expect(violations.filter((item) => item.directive === 'connect-src')).toEqual([]);
        capturedViolations.push(...violations);
        return violations;
      };
      const credentials = [];
      for (const name of ['linear', 'interrupt-resume'] as const) {
        const variants = [];
        for (const text of [false, true]) {
          const page = await openPage(context, origin);
          const result = await run(page, { name, text, exporter: 'proxy', flush: 'complete' });
          expect(result.exportErrors).toEqual({ flush: 0, shutdown: 0 });
          variants.push(await scenarioReadback(result));
          credentials.push({ scenario: name, text, calls: result.credentialCalls });
          await collectViolations(page, true);
          await page.close();
        }
        const record = { demonstration: true, variants };
        expect(
          compareLanes(
            record,
            JSON.parse(readFileSync(new URL(`node-${name}.json`, folder), 'utf8')),
          ),
        ).toEqual([]);
        writeResult(`browser-${name}.json`, record);
      }

      const directPage = await openPage(context, origin);
      const direct = await run(directPage, {
        name: 'linear',
        text: false,
        exporter: 'direct',
        flush: 'tolerate',
      });
      expect(direct.exportErrors.flush + direct.exportErrors.shutdown).toBeGreaterThan(0);
      await directPage.waitForFunction(() =>
        window.llmops.violations.some((item) => item.directive === 'connect-src'),
      );
      const directViolations = await collectViolations(directPage, false);
      expect(
        directViolations.some(
          (item) => item.directive === 'connect-src' && item.blockedURI === collectorUrl,
        ),
      ).toBe(true);
      await directPage.close();
      const positivePage = await openPage(context, origin);
      const positive = await run(positivePage, {
        name: 'linear',
        text: false,
        exporter: 'proxy',
        flush: 'complete',
      });
      await scenarioReadback(positive);
      await collectViolations(positivePage, true);
      await positivePage.close();
      const blockedCounts = await observe(direct, 15_000, true);

      const closeCases = [];
      for (const mechanism of [
        'close-no-auto-flush',
        'close-default-auto-flush',
        'navigate-default-auto-flush',
        'explicit-flush-close',
      ] as const) {
        const page = await context.newPage();
        const lifecycle: { type: string; visibility: string }[] = [];
        await page.exposeFunction('recordLifecycle', (type: string, visibility: string) => {
          lifecycle.push({ type, visibility });
        });
        await page.addInitScript(() => {
          for (const name of ['visibilitychange', 'pagehide', 'beforeunload', 'unload']) {
            const target = name === 'visibilitychange' ? document : window;
            target.addEventListener(name, () => {
              const record = Reflect.get(window, 'recordLifecycle') as (
                name: string,
                visibility: string,
              ) => void;
              record(name, document.visibilityState);
            });
          }
        });
        await page.goto(origin);
        await page.waitForFunction(() => window.llmops !== undefined);
        const autoFlushOnHide = mechanism !== 'close-no-auto-flush';
        const result = await run(page, {
          name: 'linear',
          text: false,
          exporter: 'proxy',
          flush: 'none',
          ...(autoFlushOnHide ? {} : { autoFlushOnHide: false }),
          scheduledDelayMillis: 60_000,
        });
        await collectViolations(page, true);
        if (mechanism === 'explicit-flush-close') await page.evaluate(() => window.llmops.flush());
        if (mechanism === 'navigate-default-auto-flush') await page.goto('about:blank');
        await page.close();
        closeCases.push({
          mechanism,
          scheduledDelayMillis: 60_000,
          autoFlushOnHide,
          explicitFlush: mechanism === 'explicit-flush-close',
          oracleSpans: result.spans.length,
          windowMillis: 15_000,
          // Relayed lifecycle callbacks and delivered span counts may vary with teardown timing.
          lifecycle,
          delivered: await observe(result, 15_000),
        });
      }
      await context.close();
      const requests = await Promise.all(pendingRequests);
      const wire = await Promise.all(wireRequests);
      expect(requests.length).toBeGreaterThan(0);
      expect(
        requests.some(
          (request) =>
            new URL(request.url).pathname === '/otel/v1/traces' && request.method === 'POST',
        ),
      ).toBe(true);
      expect(
        requests.every((request) => new URL(request.url).origin === new URL(origin).origin),
      ).toBe(true);
      const directRequests = requests.filter(
        (request) => new URL(request.url).origin === new URL(collectorUrl).origin,
      );
      expect(directRequests).toHaveLength(0);
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
      // Positive control: the body scan only means something if span bodies were captured.
      for (const set of [requests, wire]) {
        const exports = set.filter(
          (request) =>
            new URL(request.url).pathname === '/otel/v1/traces' && request.method === 'POST',
        );
        expect(exports.length).toBeGreaterThan(0);
        for (const request of exports) expect(request.body?.length ?? 0).toBeGreaterThan(0);
        expect(
          exports.some((request) =>
            Buffer.from(request.body ?? [])
              .toString('utf8')
              .includes('gen_ai.operation.name'),
          ),
        ).toBe(true);
      }
      expect(scanRequests(requests, env, canary)).toEqual([]);
      expect(scanRequests(wire, env, canary)).toEqual([]);
      const secret = env['LANGFUSE_AUTH_HEADER'];
      assert.ok(secret, 'Missing Basic authorization positive control');
      expect(scanBundle([secret], env).length).toBeGreaterThan(0);
      expect(
        scanRequests(
          [
            {
              url: origin,
              method: 'POST',
              headers: {
                authorization: secret,
                'x-mlflow-experiment-id': env['MLFLOW_EXPERIMENT_ID'] ?? '',
              },
              body: Buffer.from(canary),
            },
          ],
          env,
          canary,
        ).length,
      ).toBeGreaterThan(0);
      writeResult('browser-close.json', {
        demonstration: true,
        observationOnly: true,
        timingNote: 'Lifecycle callback and delivered span counts may vary between runs.',
        cases: closeCases,
      });
      writeResult('browser-evidence.json', {
        demonstration: true,
        browser: browser.version(),
        sharedPackageCopies: copies,
        csp,
        proxy: {
          method: 'Vite preview of minified production bundle',
          pagePath: '/otel/v1/traces',
          upstreamPath: '/v1/traces',
          upstream: 'loopback collector',
          collectorMappingChanged: false,
        },
        credentialPositiveControls: credentials,
        laneSpecificAttributes,
        scans: {
          timingNote: 'Playwright and receiver POST counts may vary with keepalive timing.',
          bundleFiles: files,
          bundleHits: [],
          requestHits: [],
          bundlePositiveControlDetected: true,
          requestPositiveControlDetected: true,
          requests: summarizeRequests(requests),
          proxyWireRequests: summarizeRequests(wire),
          proxyWireHits: [],
        },
        cspControl: {
          timingNote: 'CSP violation counts may vary with exporter and browser timing.',
          oracleSpans: direct.spans.length,
          exportErrors: direct.exportErrors,
          violations: directViolations.map((item) => ({
            ...item,
            blockedURI: normalizeUrl(item.blockedURI),
          })),
          collectorRequests: directRequests.length,
          laterProxiedRunReadBack: true,
          absenceWindowAfterPositiveControlMillis: 15_000,
          delivered: blockedCounts,
        },
        violations: [
          ...new Map(capturedViolations.map((item) => [JSON.stringify(item), item])).values(),
        ].map((item) => ({ ...item, blockedURI: normalizeUrl(item.blockedURI) })),
        consoleErrors: [...new Set(consoleErrors)].sort(),
        findings: [
          ...(wire.filter((request) => request.method === 'POST').length >
          requests.filter((request) => request.method === 'POST').length
            ? [
                'The preview receiver observed a keepalive export during navigation that Playwright did not report; full receiver headers and body bytes were also scanned.',
              ]
            : []),
          ...new Set(
            capturedViolations
              .filter((item) => item.directive !== 'connect-src')
              .map(
                (item) =>
                  `${item.directive} blocked ${item.blockedURI}; retained CSP without unsafe-eval`,
              ),
          ),
        ].sort(),
      });
    } finally {
      await browser?.close();
      await new Promise<void>((resolve, reject) =>
        preview.httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
