// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { expect, test } from 'vitest';
import { lockedWheels } from '../../../packages/adapter-pyodide/src/runtime-files.js';
import { cspHeader } from '../src/host/csp.js';

test('DSPy offline async import gate passes in real Chromium under the strict CSP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxie-dspy-gate-'));
  const root = fileURLToPath(new URL('./support/dspy-gate/', import.meta.url));
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
  const outDir = join(directory, 'dist');
  const define = {
    DSPY_GATE_WHEELS: JSON.stringify(
      lockedWheels.filter((wheel) => wheel.frameworks?.includes('dspy')),
    ),
    DSPY_GATE_SOURCE: JSON.stringify(
      await readFile(
        new URL('../../../python/galaxie/tests/test_dspy_gate.py', import.meta.url),
        'utf8',
      ),
    ),
  };
  await build({
    configFile: false,
    root,
    publicDir,
    logLevel: 'silent',
    define,
    worker: { format: 'es' },
    build: { outDir, emptyOutDir: true },
  });
  const server = await preview({
    configFile: false,
    root,
    logLevel: 'silent',
    build: { outDir },
    preview: {
      host: '127.0.0.1',
      port: 0,
      strictPort: true,
      headers: { 'Content-Security-Policy': cspHeader('mock') },
    },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('The preview has no port.');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const external: string[] = [];
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(
      () => {
        const state = Reflect.get(globalThis, 'dspyGate');
        return state.result !== undefined || state.error !== undefined;
      },
      undefined,
      { timeout: 60000 },
    );
    const state = await page.evaluate(() => Reflect.get(globalThis, 'dspyGate'));
    expect(state.error).toBeUndefined();
    expect(state.violations).toEqual([]);
    expect(external).toEqual([]);
    expect(state.result).toMatchObject({
      version: '3.4.1',
      anyio: true,
      termination: true,
      parseWithoutFallback: true,
    });
    expect(Object.keys(state.result.digests)).toEqual([
      'predict',
      'chain-of-thought',
      'react',
      'react-v2',
    ]);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.httpServer.close((error) => (error ? reject(error) : resolve()));
      if ('closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
  }
}, 90000);
