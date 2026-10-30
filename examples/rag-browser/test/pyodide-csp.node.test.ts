// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { expect, test } from 'vitest';
import { cspHeader } from '../src/host/csp.js';

const cache = fileURLToPath(new URL('../../../.cache/python-wheels/', import.meta.url));
const missing = 'Python wheels are not fetched; run the wheel fetch script';
const available = existsSync(join(cache, 'local-wheels.json'));
if (!available && process.env['CI']) throw new Error(missing);

test.skipIf(!available)(
  available ? 'Python installs and imports under the strict CSP without violations' : missing,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'galaxie-python-csp-'));
    const root = fileURLToPath(new URL('./support/python-csp/', import.meta.url));
    const runtime = fileURLToPath(
      new URL('../../../packages/adapter-pyodide/node_modules/pyodide/', import.meta.url),
    );
    const local = JSON.parse(await readFile(join(cache, 'local-wheels.json'), 'utf8')) as {
      packages: unknown[];
    };
    const publicDir = join(directory, 'public');
    await mkdir(join(publicDir, 'python'), { recursive: true });
    await cp(runtime, join(publicDir, 'python/runtime'), { recursive: true, dereference: true });
    await cp(cache, join(publicDir, 'python/wheels'), { recursive: true });
    const outDir = join(directory, 'dist');
    const header = cspHeader('mock');
    await build({
      configFile: false,
      root,
      publicDir,
      logLevel: 'silent',
      define: { PYTHON_LOCAL_WHEELS: JSON.stringify(local.packages) },
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
        headers: { 'Content-Security-Policy': header },
      },
    });
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('The preview has no port.');
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      const headers: string[] = [];
      context.on('response', (response) =>
        headers.push(response.headers()['content-security-policy'] ?? ''),
      );
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(origin);
      try {
        await page.waitForFunction(
          () => {
            const data = Reflect.get(globalThis, 'pythonCsp') as { events: { type: string }[] };
            return data.events.some((event) => event.type === 'result' || event.type === 'failed');
          },
          undefined,
          { timeout: 60000 },
        );
      } catch {
        throw new Error(
          JSON.stringify({
            errors,
            data: await page.evaluate(() => Reflect.get(globalThis, 'pythonCsp')),
          }),
        );
      }
      const data = await page.evaluate(() => Reflect.get(globalThis, 'pythonCsp'));
      expect(data.violations).toEqual([]);
      expect(data.events.filter((event: { type: string }) => event.type === 'violation')).toEqual(
        [],
      );
      expect(data.events.at(-1)).toMatchObject({ type: 'result', output: { value: 2 } });
      expect(errors).toEqual([]);
      console.info(
        'Python Chromium cold start (ms):',
        data.events.find((event: { type: string }) => event.type === 'ready').coldStartMs,
      );
      expect(headers.length).toBeGreaterThan(5);
      expect(headers.every((value) => value === header)).toBe(true);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => {
        server.httpServer.close((error) => (error ? reject(error) : resolve()));
        if ('closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections();
      });
      await rm(directory, { recursive: true, force: true });
    }
  },
  90000,
);
