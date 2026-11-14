// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { build, type PreviewServer, preview } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  dspyOptimizerStateCases,
  type executeDspyOptimizerStateCase,
} from '../../../tests/conformance/support/dspy-optimizer-state.js';
import { dspyOptimizerStateSources } from '../../../tests/conformance/support/dspy-optimizer-state-sources.node.js';
import { cspHeader } from '../src/host/csp.js';

let directory: string;
let server: PreviewServer | undefined;
let browser: Browser | undefined;
let origin: string;
const header = cspHeader('mock');

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'galaxie-dspy-optimizer-state-conformance-'));
  const root = fileURLToPath(
    new URL('./support/dspy-optimizer-state-conformance/', import.meta.url),
  );
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
  for (const name of dspyOptimizerStateCases) {
    const path = join(publicDir, 'conformance', name);
    await mkdir(path, { recursive: true });
    for (const [file, source] of Object.entries(await dspyOptimizerStateSources(name)))
      await writeFile(join(path, file), source);
  }
  const local = JSON.parse(
    await readFile(
      new URL('../../../.cache/python-wheels/local-wheels.json', import.meta.url),
      'utf8',
    ),
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

test.each(dspyOptimizerStateCases)(
  'Chromium loads real offline optimizer state under strict CSP: %s',
  async (name) => {
    if (!browser) throw new Error('The optimizer state browser is missing.');
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
        () => Reflect.get(globalThis, 'dspyConformance')?.done,
        undefined,
        { timeout: 900000 },
      );
      const result = (await page.evaluate(() => Reflect.get(globalThis, 'dspyConformance'))) as {
        error?: string;
        violations: string[];
        transcript: Awaited<ReturnType<typeof executeDspyOptimizerStateCase>>;
      };
      expect(result.error).toBeUndefined();
      expect(result.violations).toEqual([]);
      expect(result.transcript).toEqual(
        JSON.parse(
          await readFile(
            new URL(
              `../../../tests/conformance/golden-dspy-optimizer-state/${name}.json`,
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      );
      expect(sourceRequests).toContain(`/conformance/${name}/state.json`);
      if (name === 'optstate-forgot-lm') {
        expect(result.transcript.error).toEqual({
          code: 'unsupported',
          message: 'This operation is unsupported.',
        });
        expect(result.transcript.requests).toEqual([]);
        expect(result.transcript.capabilities).toEqual([]);
      }
      expect(external).toEqual([]);
      expect(headers.length).toBeGreaterThan(0);
      expect(headers.every((value) => value === header)).toBe(true);
    } finally {
      await context.close();
    }
  },
);
