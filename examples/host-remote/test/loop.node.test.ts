// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { build, type PreviewServer, preview } from 'vite';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { cspHeader } from '../src/csp.js';
import { createSession } from '../src/session.js';
import { sentinelSentence } from '../src/test-feedback.js';

interface RequestRecord {
  readonly url: string;
  readonly postData: string | null;
}
interface Observation {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly requests: RequestRecord[];
  readonly errors: string[];
}
interface BackendState {
  proxyBodies: unknown[];
  progress: { learnerId: string; lessonId: string; score: number; total: number }[];
  requests: Record<string, number>;
}

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const servers: PreviewServer[] = [];
const contexts: BrowserContext[] = [];
let directory: string;
let browser: Browser;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'galaxie-host-remote-'));
  for (const mode of ['test', 'production']) {
    const previous = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'production';
      await build({
        configFile,
        mode,
        logLevel: 'silent',
        build: { outDir: join(directory, mode), emptyOutDir: true },
      });
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  }
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.httpServer.close((error) => (error ? reject(error) : resolve()));
          if ('closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections();
        }),
    ),
  );
});

afterAll(async () => {
  await browser?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function serve(mode = 'test'): Promise<string> {
  const server = await preview({
    configFile,
    mode,
    logLevel: 'silent',
    build: { outDir: join(directory, mode) },
    preview: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  servers.push(server);
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing preview port.');
  return `http://127.0.0.1:${address.port}`;
}

async function observe(origin: string, mobile = false): Promise<Observation> {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
  });
  contexts.push(context);
  await context.addInitScript(() => {
    // Shadow real inference APIs before any application module evaluates.
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
    requests.push({ url: request.url(), postData: request.postData() });
    if (new URL(request.url()).origin !== origin) await route.abort('blockedbyclient');
    else await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', () => errors.push('page_error'));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push('console_error');
  });
  const response = await page.goto(origin);
  expect(response?.headers()['content-security-policy']).toBe(cspHeader());
  return { context, page, requests, errors };
}

async function state(origin: string): Promise<BackendState> {
  const token = await createSession(origin)();
  const response = await fetch(`${origin}/api/__test/state`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as BackendState;
}

function privateText(value: unknown): boolean {
  const raw = JSON.stringify(value);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw.replaceAll('+', ' '));
  } catch {}
  return [sentinelSentence, 'remote sentinel', 'sentinel 9a2d', 'she walk to school'].some(
    (part) => raw.includes(part) || decoded.includes(part),
  );
}

async function assertPage(observed: Observation, origin: string): Promise<void> {
  expect(observed.requests.length).toBeGreaterThan(0);
  for (const request of observed.requests) {
    expect(new URL(request.url).origin === origin).toBe(true);
    expect(privateText(request)).toBe(false);
  }
  expect(observed.errors).toEqual([]);
  expect(
    await observed.page.evaluate(
      () => (globalThis as typeof globalThis & { hostViolations: string[] }).hostViolations,
    ),
  ).toEqual([]);
  expect(
    await observed.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
}

async function answerLesson(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page
    .getByRole('group', { name: "Send the lesson text to this site's quiz service?", exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await page.getByRole('radio', { name: 'walk', exact: true }).check();
  expect(
    await page
      .getByRole('list', { name: 'Model destinations' })
      .getByRole('listitem')
      .allTextContents(),
  ).toEqual(['Quiz: Site quiz service (Host server)']);
  await page.getByRole('radio', { name: 'play', exact: true }).check();
  await page.getByRole('radio', { name: 'drinks', exact: true }).check();
  await page.getByRole('button', { name: 'Submit answers' }).click();
  await page.getByRole('textbox').fill(sentinelSentence);
  await page.getByRole('button', { name: 'Submit sentence' }).click();
  await page.getByText('info: Use walks with she: She walks to school.', { exact: true }).waitFor();
  expect(
    await page
      .getByRole('list', { name: 'Model destinations' })
      .getByRole('listitem')
      .allTextContents(),
  ).toEqual(['Quiz: Site quiz service (Host server)', 'Feedback: Browser feedback (In browser)']);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const confirmation = page.getByRole('group', { name: 'Save your score?', exact: true });
  await confirmation.waitFor();
  expect(await confirmation.locator('dt').allTextContents()).toEqual(['Lesson', 'Score']);
  expect(await confirmation.locator('dd').allTextContents()).toEqual(['present-simple-1', '2 / 3']);
  expect(await confirmation.getByRole('button').allTextContents()).toEqual(['Save', "Don't save"]);
}

it('completes the unchanged tutor through the proxy and confirms exactly one progress save', async () => {
  const origin = await serve();
  const observed = await observe(origin);
  const { page } = observed;
  await answerLesson(page);
  expect((await state(origin)).progress).toEqual([]);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('progressbar').waitFor();
  expect(await page.getByRole('progressbar').getAttribute('value')).toBe('2');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Run: succeeded' }).waitFor();
  expect(
    await page
      .getByRole('list', { name: 'Model destinations' })
      .getByRole('listitem')
      .allTextContents(),
  ).toEqual(['Quiz: Site quiz service (Host server)', 'Feedback: Browser feedback (In browser)']);
  const recorded = await state(origin);
  expect(recorded.progress).toEqual([
    { learnerId: 'demo-learner', lessonId: 'present-simple-1', score: 2, total: 3 },
  ]);
  expect(recorded.proxyBodies).toHaveLength(1);
  expect(recorded.proxyBodies[0]).toMatchObject({
    model: 'host-quiz',
    response_format: { type: 'json_schema' },
  });
  expect(privateText(recorded.proxyBodies)).toBe(false);
  expect(recorded.requests['POST /api/progress']).toBe(1);
  await assertPage(observed, origin);
  await page.screenshot({ path: '/tmp/galaxie-host-remote-desktop.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: 'Start', exact: true }).waitFor();
  expect(await page.getByRole('radio').count()).toBe(0);
}, 60_000);

it('declines a save without sending progress, including at a mobile width', async () => {
  const origin = await serve();
  const observed = await observe(origin, true);
  await answerLesson(observed.page);
  await observed.page.screenshot({ path: '/tmp/galaxie-host-remote-mobile.png', fullPage: true });
  await observed.page.getByRole('button', { name: "Don't save", exact: true }).click();
  await observed.page.getByRole('alert').filter({ hasText: 'Progress was not saved.' }).waitFor();
  const recorded = await state(origin);
  expect(recorded.progress).toEqual([]);
  expect(recorded.requests['POST /api/progress'] ?? 0).toBe(0);
  expect(privateText(recorded.proxyBodies)).toBe(false);
  await assertPage(observed, origin);
  await observed.page.getByRole('button', { name: 'Start over', exact: true }).click();
  await observed.page.getByRole('button', { name: 'Start', exact: true }).waitFor();
}, 60_000);

it('declines quiz consent before any proxy request', async () => {
  const origin = await serve();
  const observed = await observe(origin);
  await observed.page.getByRole('button', { name: 'Start', exact: true }).click();
  await observed.page.getByRole('button', { name: "Don't allow", exact: true }).click();
  await observed.page
    .getByRole('alert')
    .filter({ hasText: 'The quiz needs the quiz service.' })
    .waitFor();
  const recorded = await state(origin);
  expect(recorded.proxyBodies).toEqual([]);
  expect(recorded.requests['POST /api/v1/chat/completions'] ?? 0).toBe(0);
  expect(recorded.progress).toEqual([]);
  await assertPage(observed, origin);
  await observed.page.getByRole('button', { name: 'Start over', exact: true }).click();
  await observed.page.getByRole('button', { name: 'Start', exact: true }).waitFor();
}, 60_000);

it('starts over after a cached history return during a pending quiz', async () => {
  const origin = await serve();
  const observed = await observe(origin);
  const { page } = observed;
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await page.getByRole('radio', { name: 'walk', exact: true }).waitFor();
  await page.evaluate(() =>
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
  );
  await page.evaluate(() =>
    dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  await page.getByRole('button', { name: 'Start', exact: true }).waitFor();
  expect(await page.getByRole('radio').count()).toBe(0);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByRole('button', { name: "Don't allow", exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'The quiz needs the quiz service.' }).waitFor();
  await assertPage(observed, origin);
}, 60_000);

it('guards preview API routes with tokens and the listening origin', async () => {
  const origin = await serve();
  const path = `${origin}/api/lessons/present-simple-1`;
  expect((await fetch(path)).status).toBe(401);
  expect((await fetch(path, { headers: { authorization: 'Bearer unknown' } })).status).toBe(401);
  const token = await createSession(origin)();
  expect((await fetch(path, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  expect(
    (
      await fetch(path, {
        headers: { authorization: `Bearer ${token}`, origin: 'http://foreign.invalid' },
      })
    ).status,
  ).toBe(403);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      `${origin}/api/session`,
      { method: 'POST', headers: { host: 'foreign.invalid', origin: 'http://foreign.invalid' } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  expect(status).toBe(403);
  const hostOnlyStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      `${origin}/api/session`,
      {
        method: 'POST',
        headers: { host: `127.0.0.2:${new URL(origin).port}`, origin },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  expect(hostOnlyStatus).toBe(403);
});

it('loads default mode without real inference, weights or the test-only backend route', async () => {
  const origin = await serve('production');
  const observed = await observe(origin);
  await observed.page.getByRole('button', { name: 'Start', exact: true }).click();
  await observed.page
    .getByRole('alert')
    .filter({ hasText: 'This host needs Chrome Built-in AI for feedback.' })
    .waitFor();
  expect(
    observed.requests.some((request) => new URL(request.url).pathname.startsWith('/api/')),
  ).toBe(false);
  const token = await createSession(origin)();
  expect(
    (await fetch(`${origin}/api/__test/state`, { headers: { authorization: `Bearer ${token}` } }))
      .status,
  ).toBe(404);
  for (const name of await readdir(join(directory, 'production/assets'))) {
    if (name.endsWith('.js')) {
      const asset = await readFile(join(directory, 'production/assets', name), 'utf8');
      expect(asset.includes(sentinelSentence)).toBe(false);
      expect(asset.includes('@mlc-ai/web-llm')).toBe(false);
    }
  }
  await assertPage(observed, origin);
}, 60_000);
