// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { build, preview } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { cspHeader } from '../../../examples/rag-browser/src/host/csp.js';
import type { PageData } from './support/transformers-csp/report.js';

const strict = cspHeader('mock');
const withoutWasm = strict.replace(" 'wasm-unsafe-eval'", '');
let directory = '';
let browser: Browser;
const closers: Array<() => Promise<void>> = [];

async function serve(header: string): Promise<string> {
  const server = await preview({
    configFile: false,
    root: directory,
    logLevel: 'silent',
    build: { outDir: directory },
    preview: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      headers: { 'Content-Security-Policy': header },
    },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('The preview has no port.');
  closers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.httpServer.close((error) => (error ? reject(error) : resolve()));
        if ('closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${address.port}`;
}

let strictOrigin = '';
let controlOrigin = '';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'galaxie-onnx-csp-'));
  const root = fileURLToPath(new URL('./support/transformers-csp/', import.meta.url));
  await build({
    configFile: false,
    root,
    logLevel: 'silent',
    worker: { format: 'es' },
    build: {
      outDir: directory,
      emptyOutDir: true,
      rolldownOptions: { input: join(root, 'probe.html') },
    },
  });
  strictOrigin = await serve(strict);
  controlOrigin = await serve(withoutWasm);
  browser = await chromium.launch({ headless: true });
}, 180000);

afterAll(async () => {
  await browser?.close();
  for (const close of closers) await close();
  if (directory !== '') await rm(directory, { recursive: true, force: true });
});

interface Visit {
  readonly data: PageData;
  readonly errors: string[];
  readonly requested: string[];
  readonly headers: string[];
}

async function visit(origin: string): Promise<Visit> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const requested: string[] = [];
    const headers: string[] = [];
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      requested.push(url.origin);
      return url.origin === origin ? route.continue() : route.abort();
    });
    context.on('response', (response) => {
      headers.push(response.headers()['content-security-policy'] ?? '');
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`${origin}/probe.html`);
    await page.waitForFunction(
      () => (Reflect.get(globalThis, 'onnxProbe') as { done: boolean } | undefined)?.done === true,
      undefined,
      { timeout: 90000 },
    );
    const data = await page.evaluate(() => Reflect.get(globalThis, 'onnxProbe') as PageData);
    return { data, errors, requested, headers };
  } finally {
    await context.close();
  }
}

test('the ONNX runtime, tokenizer and chat template run under the strict CSP and Trusted Types', async () => {
  const { data, errors, requested, headers } = await visit(strictOrigin);
  expect(data.workerError).toBeUndefined();
  expect(data.trustedTypesPolicyCreated).toBe(true);
  expect(data.workerUrlsChecked).toBe(1);
  const report = data.report;
  expect(report?.failures).toEqual({});
  expect(report?.identity).toEqual({ input: [1, 2, 3, 4], output: [1, 2, 3, 4] });
  expect(report?.tokenizer?.ids).toEqual([[1, 2]]);
  expect(report?.tokenizer?.rendered).toContain('# Tools');
  expect(report?.tokenizer?.rendered).toContain('"name": "get_weather"');
  expect(report?.tokenizer?.rendered).toContain('<|im_start|>assistant');
  expect(report?.violations).toEqual([]);
  expect(data.pageViolations).toEqual([]);
  expect(report?.functionConstructions).toBe(0);
  expect(report?.fetchCalls).toBe(0);
  expect(new Set(report?.requestedKeys)).toEqual(
    new Set([
      '/verified-models/probe/synthetic/tokenizer.json',
      '/verified-models/probe/synthetic/tokenizer_config.json',
    ]),
  );
  expect(errors).toEqual([]);
  expect(new Set(requested)).toEqual(new Set([strictOrigin]));
  expect(headers.length).toBeGreaterThan(0);
  expect(headers.every((value) => value === strict)).toBe(true);
});

test('control: without wasm-unsafe-eval the identity graph cannot run', async () => {
  const { data, headers } = await visit(controlOrigin);
  expect(headers.every((value) => value === withoutWasm)).toBe(true);
  expect(data.workerError).toBeUndefined();
  expect(data.report?.identity).toBeUndefined();
  expect(data.report?.failures['identity']).toMatch(
    /WebAssembly\.instantiate\(\).*Content Security/s,
  );
  expect(data.report?.violations).toContain('script-src|wasm-eval|');
  // The tokenizer and template are plain JavaScript, so they still work: only the runtime needs it.
  expect(data.report?.failures['tokenizer']).toBeUndefined();
});
