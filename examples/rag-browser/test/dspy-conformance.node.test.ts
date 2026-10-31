// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import { build, type PreviewServer, preview } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { dspyCases } from '../../../tests/conformance/support/dspy.js';
import {
  type DspyReloadResult,
  dspyRejectedRestoreCases,
  dspyReloadCases,
} from '../../../tests/conformance/support/dspy-restore.js';
import { dspySources } from '../../../tests/conformance/support/dspy-sources.node.js';
import { cspHeader } from '../src/host/csp.js';

let directory: string;
let server: PreviewServer | undefined;
let browser: Browser | undefined;
let origin: string;
const header = cspHeader('mock');

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'galaxie-dspy-conformance-'));
  const root = fileURLToPath(new URL('./support/dspy-conformance/', import.meta.url));
  const publicDir = join(directory, 'public');
  await mkdir(join(publicDir, 'python'), { recursive: true });
  await cp(
    fileURLToPath(
      new URL('../../../packages/adapter-pyodide/node_modules/pyodide/', import.meta.url),
    ),
    join(publicDir, 'python/runtime'),
    { recursive: true, dereference: true },
  );
  await cp(
    fileURLToPath(new URL('../../../.cache/python-wheels/', import.meta.url)),
    join(publicDir, 'python/wheels'),
    { recursive: true },
  );
  for (const name of [...dspyCases, ...dspyReloadCases, ...dspyRejectedRestoreCases]) {
    const path = join(publicDir, 'conformance', name);
    await mkdir(path, { recursive: true });
    for (const [file, source] of Object.entries(await dspySources(name)))
      await writeFile(join(path, file), source);
  }
  const local = JSON.parse(
    await readFile(
      new URL('../../../.cache/python-wheels/local-wheels.json', import.meta.url),
      'utf8',
    ),
  );
  const changed = join(publicDir, 'conformance', 'durable-frontier-write-changed');
  await mkdir(changed, { recursive: true });
  for (const [file, source] of Object.entries(await dspySources('durable-frontier-write')))
    await writeFile(
      join(changed, file),
      file === 'selected.py'
        ? source.replace(
            'factory("durable-frontier-write")',
            'factory("durable-frontier-write", changed=True)',
          )
        : source,
    );
  const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
  const outDir = join(directory, 'dist');
  const previous = process.env['NODE_ENV'];
  try {
    process.env['NODE_ENV'] = 'production';
    await build({
      configFile,
      root,
      mode: 'mock',
      publicDir,
      logLevel: 'silent',
      define: { PYTHON_LOCAL_WHEELS: JSON.stringify(local.packages) },
      build: { outDir, emptyOutDir: true, rolldownOptions: { input: join(root, 'index.html') } },
    });
  } finally {
    if (previous === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previous;
  }
  server = await preview({
    configFile,
    root,
    mode: 'mock',
    logLevel: 'silent',
    build: { outDir },
    preview: {
      host: '127.0.0.1',
      port: 0,
      strictPort: true,
      headers: { 'Content-Security-Policy': header },
    },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string')
    throw new Error('The conformance preview has no port.');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
}, 90000);

afterAll(async () => {
  await browser?.close();
  if (server) {
    const current = server;
    await new Promise<void>((resolve, reject) => {
      current.httpServer.close((error) => (error ? reject(error) : resolve()));
      if ('closeAllConnections' in current.httpServer) current.httpServer.closeAllConnections();
    });
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test.each([
  ...dspyCases.map((name) => ({ name, steps: undefined as number | undefined })),
  { name: 'pause-two', steps: 1 },
  { name: 'pause-two', steps: 2 },
])(
  'real Chromium DSPy matches native requests, tools and output under strict CSP: $name (steps=$steps)',
  async ({ name, steps }) => {
    if (!browser) throw new Error('The conformance browser is missing.');
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const external: string[] = [];
    const headers: string[] = [];
    try {
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      context.on('response', (response) =>
        headers.push(response.headers()['content-security-policy'] ?? ''),
      );
      const page = await context.newPage();
      await page.goto(`${origin}/?case=${name}${steps === undefined ? '' : `&steps=${steps}`}`);
      await page.waitForFunction(
        () => Reflect.get(globalThis, 'dspyConformance')?.done,
        undefined,
        { timeout: 60000 },
      );
      const result = await page.evaluate(() => Reflect.get(globalThis, 'dspyConformance'));
      expect(result.error).toBeUndefined();
      expect(result.violations).toEqual([]);
      if (steps === 1) {
        expect(result.transcript.error).toEqual({
          code: 'budget_exceeded',
          message: 'The budget limit was reached.',
        });
        expect(result.transcript.requests).toHaveLength(2);
        expect(result.transcript.capabilities).toHaveLength(1);
        expect(result.transcript.interactions).toHaveLength(2);
        expect(result.transcript.output).toBeNull();
      } else
        expect(result.transcript).toEqual(
          JSON.parse(
            await readFile(
              new URL(`../../../tests/conformance/golden-dspy/${name}.json`, import.meta.url),
              'utf8',
            ),
          ),
        );
      expect(external).toEqual([]);
      expect(headers.length).toBeGreaterThan(0);
      expect(headers.every((value) => value === header)).toBe(true);
    } finally {
      await context.close();
    }
  },
  90000,
);

async function reloadResult(page: Page): Promise<{
  reload: DspyReloadResult;
  error?: string;
  errorCode?: string;
  violations: string[];
  exported: { checkpoints?: unknown; metadata: { pendingInteractionCount: number } };
  personal: { checkpoints: { executor: string }[] };
}> {
  await page.waitForFunction(() => Reflect.get(globalThis, 'dspyConformance')?.done, undefined, {
    timeout: 60000,
  });
  return page.evaluate(() => Reflect.get(globalThis, 'dspyConformance'));
}
async function nextReload(
  page: Page,
  name: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof reloadResult>>> {
  await page.evaluate((step) => sessionStorage.setItem('dspyReloadStep', JSON.stringify(step)), {
    name,
    sessionId,
    ...extra,
  });
  await page.reload();
  return reloadResult(page);
}

test.each(dspyRejectedRestoreCases)(
  'Chromium refuses a rejected private URL after reopening IndexedDB: %s',
  async (name) => {
    if (!browser) throw new Error('The conformance browser is missing.');
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const external: string[] = [];
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?case=${name}&reload`);
      const first = await reloadResult(page);
      expect(first.reload.error).toEqual({ code: 'denied', message: 'Policy denied the request.' });
      expect(first.reload.pending).toBeUndefined();
      expect(first.reload.requests).toBe(0);
      const restored = await nextReload(page, name, first.reload.sessionId);
      expect(restored.errorCode).toBe('denied');
      expect(restored.reload).toBeUndefined();
      expect(restored.violations).toEqual([]);
      expect(external).toEqual([]);
    } finally {
      await context.close();
    }
  },
  90000,
);

test.each(dspyReloadCases)(
  'Chromium reopens IndexedDB and a fresh DSPy Worker: %s',
  async (name) => {
    if (!browser) throw new Error('The conformance browser is missing.');
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const external: string[] = [];
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?case=${name}&reload`);
      let result = await reloadResult(page);
      expect(result.error).toBeUndefined();
      const calls = [...result.reload.calls];
      for (let index = 0; result.reload.pending && index < 3; index++) {
        const pending = result.reload.pending;
        result = await nextReload(page, name, result.reload.sessionId);
        expect(result.error).toBeUndefined();
        expect(result.reload.restored).toEqual(pending);
        calls.push(...result.reload.calls);
      }
      expect(result.violations).toEqual([]);
      expect(external).toEqual([]);
      expect(result.reload.requests).toBe(1);
      expect(result.reload.pending).toBeUndefined();
      expect(calls).toEqual(
        name === 'durable-frontier-write'
          ? ['after']
          : name === 'durable-oversize-completion'
            ? ['before', 'large-0', 'large-1', 'large-2']
            : ['before'],
      );
      if (name.startsWith('durable-private-'))
        expect(result.reload.error).toMatchObject({ code: 'denied' });
      else {
        expect(result.reload.output).toEqual({
          answer: 'done',
          receipt: 'RESTORED_CAPABILITY_SECRET',
        });
        expect(result.reload.consumed).toBe(true);
        expect(result.exported.metadata.pendingInteractionCount).toBe(0);
      }
      expect(result.exported.checkpoints).toBeUndefined();
      expect(result.personal.checkpoints.every((row) => row.executor === 'dspy-python')).toBe(true);
      expect(JSON.stringify(result.exported)).not.toContain('RESTORED_');
      if (name === 'durable-oversize-completion') {
        expect(result.reload.streams).not.toContainEqual({ kind: 'checkpoint_dropped' });
        result = await nextReload(page, name, result.reload.sessionId);
        expect(result.reload.calls).toEqual([]);
        expect(result.reload.requests).toBe(0);
        expect(result.reload.pending).toBeUndefined();
      }
    } finally {
      await context.close();
    }
  },
  90000,
);

test.each([
  'accepted',
  'crash',
  'changed',
  'unfinished',
  'orphan',
  'completion',
  'executor',
  'version',
  'format',
  'session',
  'corrupt',
  'logout',
  'takeover',
])(
  'Chromium DSPy reload recovery and byte-record boundaries: %s',
  async (fault) => {
    if (!browser) throw new Error('The conformance browser is missing.');
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const external: string[] = [];
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    try {
      const name = ['crash', 'changed', 'unfinished'].includes(fault)
        ? 'durable-frontier-write'
        : 'durable-module';
      const page = await context.newPage();
      await page.goto(`${origin}/?case=${name}&reload${fault === 'accepted' ? '&accepted' : ''}`);
      const first = await reloadResult(page);
      expect(first.reload.pending).toBeDefined();
      if (['crash', 'changed', 'unfinished'].includes(fault)) {
        const lost = await nextReload(page, name, first.reload.sessionId, {
          crashAfterWrite: true,
          ...(fault === 'unfinished' ? { fault } : {}),
        });
        expect(lost.reload.crashed).toBe(true);
        expect(lost.reload.calls).toEqual(['after']);
      }
      let result = await nextReload(page, name, first.reload.sessionId, { fault });
      if (fault === 'completion') {
        expect(result.reload.error).toEqual({
          code: 'unavailable',
          message: 'The requested service is unavailable.',
        });
        expect(result.reload.consumed).toBe(false);
        result = await nextReload(page, name, first.reload.sessionId);
      }
      expect(result.violations).toEqual([]);
      expect(external).toEqual([]);
      if (['accepted', 'crash', 'orphan', 'completion'].includes(fault)) {
        expect(result.error).toBeUndefined();
        expect(result.reload.calls).toEqual([]);
        expect(result.reload.output).toEqual({
          answer: 'done',
          receipt: 'RESTORED_CAPABILITY_SECRET',
        });
        expect(result.reload.consumed).toBe(true);
        if (fault === 'accepted') expect(result.reload.restored).toBeUndefined();
        if (fault === 'orphan') expect(result.exported.metadata.pendingInteractionCount).toBe(0);
      } else if (['changed', 'unfinished'].includes(fault)) {
        expect(result.reload.calls).toEqual([]);
        expect(result.reload.requests).toBe(0);
        expect(result.reload.error).toMatchObject({
          code: fault === 'changed' ? 'unrecoverable' : 'outcome_unknown',
        });
      } else if (fault === 'executor') {
        expect(result.errorCode).toBe('unsupported');
        expect(result.error).toBe('The saved session uses a different executor.');
      } else if (['logout', 'takeover'].includes(fault))
        expect(result.reload.error).toMatchObject({
          code: fault === 'logout' ? 'stale' : 'fenced',
        });
      else expect(result.errorCode).toBe('unrecoverable');
    } finally {
      await context.close();
    }
  },
  90000,
);
