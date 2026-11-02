// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { build, preview } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { cspHeader } from '../../../examples/host-local/src/csp.js';
import { CANARY_ARGUMENT, CANARY_PROMPT, CANARY_REPLY, CANARY_RESULT } from './bundle-probe.js';
import type { PageData } from './support/bundle-csp/page.js';

const PAGES = ['plain', 'control', 'traced', 'traced-private'] as const;
// A host that ships spans to a collector turns ADK span content capture off at build time:
// the bundle inlines `process.env` as `{}`, so only a bundler define can reach its flag.
const CONTENT_FLAG_DEFINE = {
  'process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS': JSON.stringify('false'),
} as const;
const header = cspHeader('mock');
let directory = '';
let origin = '';
let browser: Browser;
let closeServer: () => Promise<void>;
const headers: string[] = [];

async function buildPageInIsolation(page: (typeof PAGES)[number], root: string): Promise<void> {
  await build({
    configFile: false,
    root,
    base: `/${page}/`,
    logLevel: 'silent',
    define: page === 'traced-private' ? CONTENT_FLAG_DEFINE : {},
    build: {
      outDir: join(directory, page),
      emptyOutDir: true,
      rolldownOptions: { input: join(root, `${page}.html`) },
    },
  });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'galaxie-adk-csp-'));
  const root = fileURLToPath(new URL('./support/bundle-csp/', import.meta.url));
  await Promise.all(PAGES.map((page) => buildPageInIsolation(page, root)));
  const server = await preview({
    configFile: false,
    root: directory,
    logLevel: 'silent',
    build: { outDir: directory },
    preview: {
      host: '127.0.0.1',
      port: 0,
      strictPort: true,
      headers: { 'Content-Security-Policy': header },
    },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('The preview has no port.');
  origin = `http://127.0.0.1:${address.port}`;
  closeServer = () =>
    new Promise<void>((resolve, reject) => {
      server.httpServer.close((error) => (error ? reject(error) : resolve()));
      if ('closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections();
    });
  browser = await chromium.launch({ headless: true });
}, 120000);

afterAll(async () => {
  await browser?.close();
  await closeServer?.();
  if (directory !== '') await rm(directory, { recursive: true, force: true });
});

interface Visit {
  readonly data: PageData;
  readonly errors: string[];
  readonly requested: string[];
}

async function visit(path: string): Promise<Visit> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const requested: string[] = [];
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      requested.push(url.origin);
      return url.origin === origin ? route.continue() : route.abort();
    });
    context.on('response', (response) =>
      headers.push(response.headers()['content-security-policy'] ?? ''),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`${origin}${path}`);
    await page.waitForFunction(
      () => (Reflect.get(globalThis, 'adkProbe') as { done: boolean } | undefined)?.done === true,
      undefined,
      { timeout: 30000 },
    );
    const data = await page.evaluate(() => Reflect.get(globalThis, 'adkProbe') as PageData);
    return { data, errors, requested };
  } finally {
    await context.close();
  }
}

function canaries(value: unknown): string[] {
  const text = JSON.stringify(value);
  return [CANARY_PROMPT, CANARY_REPLY, CANARY_ARGUMENT, CANARY_RESULT].filter((canary) =>
    text.includes(canary),
  );
}

test('the built pages carry no Node-only module', async () => {
  for (const page of PAGES) {
    const assets = (await readdir(join(directory, page, 'assets'))).filter((name) =>
      name.endsWith('.js'),
    );
    expect(assets.length).toBeGreaterThan(0);
    for (const name of assets) {
      const source = await readFile(join(directory, page, 'assets', name), 'utf8');
      expect(source).not.toMatch(/from\s*["']node:|require\(["']node:/);
    }
  }
});

test('a tool-calling agent runs under the strict CSP and Trusted Types with no process global', async () => {
  const { data, errors, requested } = await visit('/plain/plain.html');
  expect(data.failure).toBeUndefined();
  expect(data.result).toMatchObject({
    text: CANARY_REPLY,
    calls: ['echo'],
    toolInput: CANARY_ARGUMENT,
    network: [],
    functionConstructions: 0,
    hadProcess: false,
    violations: [],
  });
  expect(errors).toEqual([]);
  expect(new Set(requested)).toEqual(new Set([origin]));
  expect(headers.length).toBeGreaterThan(0);
  expect(headers.every((value) => value === header)).toBe(true);
});

test('control: without the zod jitless prelude the bundle trips the Trusted Types sink', async () => {
  const { data } = await visit('/control/control.html');
  expect(data.failure).toBeUndefined();
  expect(data.result?.violations.length).toBeGreaterThan(0);
  for (const violation of data.result?.violations ?? [])
    expect(violation).toMatch(/^require-trusted-types-for\|trusted-types-sink\|Function\|/);
});

test('ADK spans reach a host provider registered before the bundle, with content by default', async () => {
  const { data, errors } = await visit('/traced/traced.html');
  expect(data.failure).toBeUndefined();
  expect(errors).toEqual([]);
  expect(data.result?.violations).toEqual([]);
  expect(data.result?.hadProcess).toBe(false);
  expect(data.spans?.map((span) => span.name)).toEqual(
    expect.arrayContaining(['invocation', 'invoke_agent probe', 'call_llm', 'execute_tool echo']),
  );
  expect(canaries(data.spans)).toEqual(
    expect.arrayContaining([CANARY_PROMPT, CANARY_ARGUMENT, CANARY_RESULT]),
  );
});

test('a build-time define of the content flag keeps prompts, arguments and results out of spans', async () => {
  const { data } = await visit('/traced-private/traced-private.html');
  expect(data.failure).toBeUndefined();
  expect(data.result?.violations).toEqual([]);
  expect(data.spans?.length).toBeGreaterThan(0);
  expect(canaries(data.spans)).toEqual([]);
});
