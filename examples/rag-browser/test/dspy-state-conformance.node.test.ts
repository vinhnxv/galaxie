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
  dspyStateCases,
  type executeDspyStateCase,
} from '../../../tests/conformance/support/dspy-state.js';
import {
  limitSources,
  stateLimitCases,
  syntheticState,
} from '../../../tests/conformance/support/dspy-state-limits.js';
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
