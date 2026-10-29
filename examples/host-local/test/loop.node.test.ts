// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { build, type PreviewServer, preview } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cspHeader } from '../src/csp.js';
import { sentinelSentence } from '../src/mock-script.js';

interface RequestRecord {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly postData: string | null;
}

interface Observation {
  readonly requests: RequestRecord[];
  readonly errors: string[];
  readonly consoleErrors: string[];
  readonly page: Page;
  readonly context: BrowserContext;
}

const distinctiveSpans = [
  sentinelSentence,
  'Galaxie sentinel',
  'sentinel 7f3e',
  '7f3e she',
  'she walk to school',
];
function containsSentence(request: RequestRecord): boolean {
  const raw = JSON.stringify(request);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw.replaceAll('+', ' '));
  } catch {}
  return distinctiveSpans.some((span) => raw.includes(span) || decoded.includes(span));
}

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const servers: PreviewServer[] = [];
let directory: string;
let browser: Browser;
let mockOrigin: string;
let defaultOrigin: string;
let defaultEntry: string;

async function serve(mode: string): Promise<string> {
  const outDir = join(directory, mode);
  const previous = process.env['NODE_ENV'];
  try {
    process.env['NODE_ENV'] = 'production';
    await build({
      configFile,
      mode,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true, manifest: true },
    });
  } finally {
    if (previous === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previous;
  }
  if (mode !== 'mock') {
    const manifest = JSON.parse(
      await readFile(join(outDir, '.vite/manifest.json'), 'utf8'),
    ) as Record<string, { file: string }>;
    const entry = manifest['src/main.tsx'];
    if (!entry) throw new Error('The exported application entry is missing.');
    defaultEntry = `/${entry.file}`;
    for (const name of await readdir(join(outDir, 'assets'))) {
      if (name.endsWith('.js'))
        expect(await readFile(join(outDir, 'assets', name), 'utf8')).not.toContain(
          sentinelSentence,
        );
    }
  }
  const server = await preview({
    configFile,
    mode,
    logLevel: 'silent',
    build: { outDir },
    preview: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  servers.push(server);
  const address = server.httpServer.address();
  if (!address || typeof address === 'string')
    throw new Error('The preview server has no TCP port.');
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'galaxie-host-local-'));
  mockOrigin = await serve('mock');
  defaultOrigin = await serve('production');
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-webgpu'] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.httpServer.close((error) => (error ? reject(error) : resolve()));
          if ('closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections();
        }),
    ),
  );
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function observe(origin: string): Promise<Observation> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => {
    Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
    const violations: string[] = [];
    Object.assign(globalThis, { hostViolations: violations });
    addEventListener('securitypolicyviolation', (event) =>
      violations.push(event.effectiveDirective),
    );
  });
  const requests: RequestRecord[] = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    requests.push({
      url: request.url(),
      method: request.method(),
      headers: await request.allHeaders(),
      postData: request.postData(),
    });
    if (new URL(request.url()).origin !== origin) await route.abort('blockedbyclient');
    else await route.continue();
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  return { requests, errors, consoleErrors, page, context };
}

async function violations(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (globalThis as typeof globalThis & { hostViolations: string[] }).hostViolations,
  );
}

function assertLocalRequests(requests: readonly RequestRecord[], origin: string): void {
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(new URL(request.url).origin).toBe(origin);
    expect(request.method).toBe('GET');
    expect(containsSentence(request)).toBe(false);
  }
}

it('completes the mock lesson without sentence egress and enforces the CSP', async () => {
  const observed = await observe(mockOrigin);
  const { page, context, requests, errors, consoleErrors } = observed;
  try {
    const response = await page.goto(mockOrigin);
    expect(response?.headers()['content-security-policy']).toBe(cspHeader('mock'));
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('radio', { name: 'walk', exact: true }).check();
    await page.getByRole('radio', { name: 'play', exact: true }).check();
    await page.getByRole('radio', { name: 'drinks', exact: true }).check();
    await page.getByRole('button', { name: 'Submit answers' }).click();
    await page.getByRole('textbox').fill(sentinelSentence);
    await page.getByRole('button', { name: 'Submit sentence' }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Run: succeeded; Score: 2/3' }).waitFor();
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(await violations(page)).toEqual([]);
    assertLocalRequests(requests, mockOrigin);

    const negativeUrl = `${mockOrigin}/leak-control?sentence=${encodeURIComponent(sentinelSentence)}`;
    await page.evaluate(async (url) => {
      await fetch(url);
    }, negativeUrl);
    const negative = requests.filter((request) => request.url === negativeUrl);
    expect(negative).toHaveLength(1);
    expect(containsSentence(negative[0] as RequestRecord)).toBe(true);

    expect(
      await page.evaluate(async () => {
        try {
          await fetch('https://example.com/');
          return 'allowed';
        } catch {
          return 'rejected';
        }
      }),
    ).toBe('rejected');
    const cdp = await context.newCDPSession(page);
    try {
      const evaluation = await cdp.send('Runtime.evaluate', {
        expression:
          "(() => { try { eval('1 + 1'); return 'allowed'; } catch (error) { return error.name; } })()",
        allowUnsafeEvalBlockedByCSP: false,
        returnByValue: true,
      });
      expect(evaluation.result.value).toBe('EvalError');
    } finally {
      await cdp.detach();
    }
    expect(
      await page.evaluate(() => {
        try {
          document.createElement('div').innerHTML = '<b>probe</b>';
          return 'allowed';
        } catch (error) {
          return error instanceof TypeError ? 'TypeError' : 'other';
        }
      }),
    ).toBe('TypeError');
    await expect
      .poll(() => violations(page))
      .toEqual(['connect-src', 'require-trusted-types-for', 'require-trusted-types-for']);
    expect(errors).toEqual([]);
    expect(
      consoleErrors.every((message) =>
        /Content Security Policy|TrustedHTML|TrustedScript/.test(message),
      ),
    ).toBe(true);
    assertLocalRequests(
      requests.filter((request) => request.url !== negativeUrl),
      mockOrigin,
    );
  } finally {
    await context.close();
  }
}, 60_000);

it('loads default mode and constructs the bundled worker without a model or download', async () => {
  const { page, context, requests, errors, consoleErrors } = await observe(defaultOrigin);
  try {
    const response = await page.goto(defaultOrigin);
    expect(response?.headers()['content-security-policy']).toBe(cspHeader('production'));
    await page.getByRole('button', { name: 'Prepare models', exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Start', exact: true }).isDisabled()).toBe(true);
    expect(await violations(page)).toEqual([]);
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    const [worker, constructed] = await Promise.all([
      page.waitForEvent('worker'),
      // Keep import() as page JavaScript; Vitest otherwise rewrites it as an SSR import.
      page.evaluate<string>(`(async () => {
        const { createWebLLMWorker } = await import(${JSON.stringify(defaultEntry)});
        await createWebLLMWorker();
        return 'constructed';
      })()`),
    ]);
    expect(constructed).toBe('constructed');
    expect(await worker.evaluate(() => 'ready')).toBe('ready');
    await expect
      .poll(() => requests.some((request) => /\/assets\/webllm-worker-/.test(request.url)))
      .toBe(true);
    expect(
      requests.some((request) => /\/assets\/(lib|worker)-|\.(wasm|bin)(\?|$)/.test(request.url)),
    ).toBe(false);
    expect(await violations(page)).toEqual([]);
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    assertLocalRequests(requests, defaultOrigin);
  } finally {
    await context.close();
  }
}, 60_000);
