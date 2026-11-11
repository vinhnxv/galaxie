// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import { build, type PreviewServer, preview } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type {
  DspyReloadResult,
  DspyReloadStep,
} from '../../../tests/conformance/support/dspy-restore.js';
import {
  dspyStateCases,
  type executeDspyStateCase,
} from '../../../tests/conformance/support/dspy-state.js';
import { stateBindScenarios } from '../../../tests/conformance/support/dspy-state-bind.js';
import { stateBindSources } from '../../../tests/conformance/support/dspy-state-bind-sources.node.js';
import {
  limitSources,
  stateLimitCases,
  syntheticState,
} from '../../../tests/conformance/support/dspy-state-limits.js';
import { stateRestoreScenarios } from '../../../tests/conformance/support/dspy-state-restore.js';
import { stateRestoreSources } from '../../../tests/conformance/support/dspy-state-restore-sources.node.js';
import {
  dspyStateSources,
  selectedStateSource,
} from '../../../tests/conformance/support/dspy-state-sources.node.js';
import { cspHeader } from '../src/host/csp.js';

let directory: string;
let server: PreviewServer | undefined;
let browser: Browser | undefined;
let origin: string;
const header = cspHeader('mock');

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'galaxie-dspy-state-conformance-'));
  const root = fileURLToPath(new URL('./support/dspy-state-conformance/', import.meta.url));
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
  for (const name of dspyStateCases) {
    const path = join(publicDir, 'conformance', name);
    await mkdir(path, { recursive: true });
    for (const [file, source] of Object.entries(await dspyStateSources(name)))
      await writeFile(join(path, file), source);
  }
  for (const scenario of stateRestoreScenarios) {
    for (const lifetime of scenario.swap === 'same'
      ? (['pause'] as const)
      : (['pause', 'resume'] as const)) {
      const name = scenario.name + (lifetime === 'resume' ? '-resume' : '');
      const path = join(publicDir, 'conformance', name);
      await mkdir(path, { recursive: true });
      for (const [file, source] of Object.entries(await stateRestoreSources(scenario, lifetime)))
        await writeFile(join(path, file), source);
    }
  }
  for (const scenario of stateBindScenarios.filter((scenario) =>
    scenario.lanes.includes('chromium'),
  )) {
    for (const lifetime of ['pause', 'resume'] as const) {
      const path = join(
        publicDir,
        'conformance',
        scenario.name + (lifetime === 'resume' ? '-resume' : ''),
      );
      await mkdir(path, { recursive: true });
      for (const [file, source] of Object.entries(await stateBindSources(scenario, lifetime)))
        await writeFile(join(path, file), source);
    }
  }
  const local = JSON.parse(
    await readFile(
      new URL('../../../.cache/python-wheels/local-wheels.json', import.meta.url),
      'utf8',
    ),
  );
  const suite = await readFile(
    new URL('../../../tests/conformance/cases-dspy/state_suite.py', import.meta.url),
    'utf8',
  );
  for (const [name, spec] of Object.entries(stateLimitCases)) {
    const path = join(publicDir, 'conformance', name);
    await mkdir(path, { recursive: true });
    const sources = limitSources(
      suite,
      selectedStateSource('state-limits'),
      syntheticState(spec.bytes).text,
    );
    for (const [file, source] of Object.entries(sources)) await writeFile(join(path, file), source);
  }
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
}, 900000);

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

test.each([...dspyStateCases, ...Object.keys(stateLimitCases), 'state-pickle-source'])(
  'real Chromium loads offline DSPy state under strict CSP: %s',
  async (name) => {
    if (!browser) throw new Error('The state conformance browser is missing.');
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const external: string[] = [];
    const headers: string[] = [];
    const sourceRequests: string[] = [];
    try {
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/conformance/')) sourceRequests.push(url.pathname);
        if (url.origin === origin) return route.continue();
        external.push(url.href);
        return route.abort();
      });
      context.on('response', (response) =>
        headers.push(response.headers()['content-security-policy'] ?? ''),
      );
      const page = await context.newPage();
      await page.goto(`${origin}/?case=${name}`);
      await page.waitForFunction(
        () => Reflect.get(globalThis, 'dspyStateConformance')?.done,
        undefined,
        { timeout: 60000 },
      );
      const result = (await page.evaluate(() =>
        Reflect.get(globalThis, 'dspyStateConformance'),
      )) as {
        error?: string;
        violations: string[];
        transcript: Awaited<ReturnType<typeof executeDspyStateCase>>;
      };
      expect(result.error).toBeUndefined();
      expect(result.violations).toEqual([]);
      if (dspyStateCases.includes(name)) {
        expect(result.transcript).toEqual(
          JSON.parse(
            await readFile(
              new URL(`../../../tests/conformance/golden-dspy-state/${name}.json`, import.meta.url),
              'utf8',
            ),
          ),
        );
        expect(sourceRequests).toContain(`/conformance/${name}/state.json`);
        if (name === 'state-hostile-lm' || name === 'state-forgot-lm') {
          expect(result.transcript.error).toEqual({
            code: 'unsupported',
            message: 'This operation is unsupported.',
          });
          expect(result.transcript.requests).toEqual([]);
        }
      } else if (name === 'state-limit-accepted') {
        expect(result.transcript.error).toBeNull();
        expect(result.transcript.output).toMatchObject({
          answer: 'Paris',
          demos: syntheticState(256 * 1024).demos,
        });
      } else {
        expect(result.transcript.error).toMatchObject({
          code: name === 'state-pickle-source' ? 'invalid' : stateLimitCases[name]?.code,
        });
        expect(result.transcript.requests).toEqual([]);
        if (name === 'state-pickle-source') expect(sourceRequests).toEqual([]);
      }
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
  bindTraffic?: { models: number; capabilities: number; replayed: number };
}> {
  await page.waitForFunction(
    () => Reflect.get(globalThis, 'dspyStateConformance')?.done,
    undefined,
    { timeout: 60000 },
  );
  return page.evaluate(() => Reflect.get(globalThis, 'dspyStateConformance'));
}

async function nextReload(
  page: Page,
  step: DspyReloadStep & { variant?: 'resume' },
): ReturnType<typeof reloadResult> {
  await page.evaluate(
    (step) => sessionStorage.setItem('dspyStateReloadStep', JSON.stringify(step)),
    step,
  );
  await page.reload();
  return reloadResult(page);
}

test.each(stateRestoreScenarios)(
  'Chromium resumes a paused DSPy session across a state swap: $name',
  async (scenario) => {
    if (!browser) throw new Error('The state conformance browser is missing.');
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const external: string[] = [];
    const headers: string[] = [];
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    context.on('response', (response) =>
      headers.push(response.headers()['content-security-policy'] ?? ''),
    );
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?case=${scenario.name}&reload`);
      const first = await reloadResult(page);
      expect(first.error).toBeUndefined();
      expect(first.violations).toEqual([]);
      expect(first.reload.pending).toBeDefined();
      expect(first.reload.error).toBeUndefined();
      expect(first.reload.calls).toEqual(['before']);
      expect(first.reload.requests).toBe(scenario.program === 'state-durable-early-model' ? 1 : 0);
      const step = { name: scenario.program, sessionId: first.reload.sessionId };
      const restored = await nextReload(page, {
        ...step,
        ...(scenario.swap === 'same' ? {} : { variant: 'resume' as const }),
      });
      expect(restored.error).toBeUndefined();
      expect(restored.violations).toEqual([]);
      expect(restored.reload.restored).toEqual(first.reload.pending);
      expect(restored.reload.pending).toBeUndefined();
      expect(restored.reload.calls).toEqual([]);
      if (scenario.outcome === 'completes') {
        const sources = await stateRestoreSources(scenario, 'resume');
        const state = JSON.parse(sources['state.json'] ?? '');
        expect(restored.reload.error).toBeUndefined();
        expect(restored.reload.output).toEqual({
          answer: 'done',
          receipt: 'RESTORED_CAPABILITY_SECRET',
          demos: state.demos.length,
          instructions: state.signature.instructions,
        });
        expect(restored.reload.requests).toBe(1);
        expect(restored.reload.consumed).toBe(true);
      } else {
        expect(restored.reload.error).toMatchObject({ code: 'unrecoverable' });
        expect(restored.reload.output).toBeUndefined();
        expect(restored.reload.requests).toBe(0);
        const poisoned = await nextReload(page, step);
        expect(poisoned.errorCode).toBe('unrecoverable');
        expect(poisoned.reload).toBeUndefined();
        expect(poisoned.violations).toEqual([]);
      }
      expect(external).toEqual([]);
      expect(headers.length).toBeGreaterThan(0);
      expect(headers.every((value) => value === header)).toBe(true);
    } finally {
      await context.close();
    }
  },
  90000,
);

/** Compare all stored bytes and effect rows around a refused restore. */
async function bindingStore(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('dspy-state-reload');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const stores = ['checkpoints', 'writes', 'journal'];
      const tx = db.transaction(stores, 'readonly');
      const rows = await Promise.all(
        stores.map(
          (name) =>
            new Promise<unknown>((resolve, reject) => {
              const request = tx.objectStore(name).getAll();
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            }),
        ),
      );
      return JSON.stringify(rows, (_key, value: unknown) =>
        value instanceof Uint8Array ? [...value] : value,
      );
    } finally {
      db.close();
    }
  });
}

test.each(stateBindScenarios.filter((scenario) => scenario.lanes.includes('chromium')))(
  'Chromium binds paused DSPy state before replay: $name',
  async (scenario) => {
    if (!browser) throw new Error('The state conformance browser is missing.');
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const external: string[] = [];
    const headers: string[] = [];
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    context.on('response', (response) =>
      headers.push(response.headers()['content-security-policy'] ?? ''),
    );
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?case=${scenario.name}&reload`);
      const first = await reloadResult(page);
      expect(first.error).toBeUndefined();
      expect(first.violations).toEqual([]);
      expect(first.reload.error).toBeUndefined();
      expect(first.reload.pending).toBeDefined();
      expect(first.reload.calls).toEqual(['before']);
      expect(first.reload.requests).toBe(scenario.program === 'state-durable-early-model' ? 1 : 0);
      const saved = await bindingStore(page);
      const step = { name: scenario.program, sessionId: first.reload.sessionId };
      const restored = await nextReload(page, { ...step, variant: 'resume' });
      expect(restored.violations).toEqual([]);
      if (scenario.predicted === 'unrecoverable') {
        expect(restored.errorCode).toBe('unrecoverable');
        expect(restored.error).toBe('Stored state cannot be recovered.');
        expect(restored.reload).toBeUndefined();
        expect(restored.bindTraffic).toEqual({ models: 0, capabilities: 0, replayed: 0 });
        expect(await bindingStore(page)).toBe(saved);
      } else {
        const sources = await stateBindSources(scenario, 'resume');
        const state = JSON.parse(sources['state.json'] ?? '');
        expect(restored.error).toBeUndefined();
        expect(restored.reload.restored).toEqual(first.reload.pending);
        expect(restored.reload.pending).toBeUndefined();
        expect(restored.reload.error).toBeUndefined();
        expect(restored.reload.output).toEqual({
          answer: 'done',
          receipt: 'RESTORED_CAPABILITY_SECRET',
          demos: state.demos.length,
          instructions: state.signature.instructions,
        });
        expect(restored.reload.calls).toEqual([]);
        expect(restored.reload.requests).toBe(1);
        expect(restored.reload.consumed).toBe(true);
        expect(restored.bindTraffic).toEqual({ models: 1, capabilities: 0, replayed: 1 });
      }
      if (scenario.then === 'original') {
        const rollback = await nextReload(page, step);
        expect(rollback.error).toBeUndefined();
        expect(rollback.violations).toEqual([]);
        expect(rollback.reload.restored).toEqual(first.reload.pending);
        expect(rollback.reload.error).toBeUndefined();
        expect(rollback.reload.output).toMatchObject({ answer: 'done', demos: 2 });
        expect(rollback.reload.calls).toEqual([]);
        expect(rollback.bindTraffic).toEqual({ models: 1, capabilities: 0, replayed: 1 });
      }
      expect(external).toEqual([]);
      expect(headers.length).toBeGreaterThan(0);
      expect(headers.every((value) => value === header)).toBe(true);
    } finally {
      await context.close();
    }
  },
  900000,
);
