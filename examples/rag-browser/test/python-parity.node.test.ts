// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { build, type PreviewServer, preview } from 'vite';
import { expect, test } from 'vitest';
import { cspHeader } from '../src/host/csp.js';
import { missingPythonWheels, pythonWheelsAvailable } from './support/python.node.js';
import { reviewExpected } from './support/review.js';
import { assertTranscript, goldenTranscript } from './support/transcript.js';

test.skipIf(!pythonWheelsAvailable).each([false, true])(
  pythonWheelsAvailable
    ? 'Pyodide in Chromium replays the shared behavioral transcript under strict CSP (review=%s)'
    : missingPythonWheels,
  async (review) => {
    const directory = await mkdtemp(join(tmpdir(), 'galaxie-python-parity-'));
    const root = fileURLToPath(new URL('./support/python-parity/', import.meta.url));
    const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
    const outDir = join(directory, 'dist');
    const header = cspHeader('mock');
    let server: PreviewServer | undefined;
    let browser: Browser | undefined;
    try {
      const previous = process.env['NODE_ENV'];
      try {
        process.env['NODE_ENV'] = 'production';
        await build({
          configFile,
          root,
          mode: 'mock',
          publicDir: false,
          logLevel: 'silent',
          build: {
            outDir,
            emptyOutDir: true,
            rolldownOptions: { input: join(root, 'index.html') },
          },
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
        throw new Error('The parity preview has no port.');
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const external: string[] = [];
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      const responseHeaders: string[] = [];
      const bodies: Promise<{ path: string; bytes: number }>[] = [];
      context.on('response', (response) => {
        responseHeaders.push(response.headers()['content-security-policy'] ?? '');
        const path = new URL(response.url()).pathname;
        if (path.startsWith('/python/') || path.includes('pyodide-worker'))
          bodies.push(response.body().then((body) => ({ path, bytes: body.length })));
      });
      const page = await context.newPage();
      await page.goto(`${origin}/${review ? '?review' : ''}`, { timeout: 15000 });
      await page.waitForFunction(() => Reflect.get(globalThis, 'pythonParity')?.done, {
        timeout: 60000,
      });
      const result = await page.evaluate(() => Reflect.get(globalThis, 'pythonParity'));
      expect(result.error).toBeUndefined();
      expect(typeof result.coldStartMs).toBe('number');
      expect(result.violations).toEqual([]);
      assertTranscript(result.transcript, review ? reviewExpected : goldenTranscript);
      expect(external).toEqual([]);
      expect(responseHeaders.length).toBeGreaterThan(5);
      expect(responseHeaders.every((value) => value === header)).toBe(true);
      const files = await Promise.all(bodies);
      const declaredBytes = Number(
        await page.locator('meta[name="galaxie-python-bytes"]').getAttribute('content'),
      );
      const responseBodyBytes = files.reduce((sum, file) => sum + file.bytes, 0);
      expect(responseBodyBytes).toBe(declaredBytes);
      const worker = files.find((file) => file.path.includes('pyodide-worker'));
      await writeFile(
        '/tmp/galaxie-rag-python-chromium-metrics.json',
        JSON.stringify(
          {
            browser: browser.version(),
            coldStartMs: result.coldStartMs,
            responseBodyBytes,
            workerBytes: worker?.bytes,
            files,
          },
          null,
          2,
        ),
      );
    } finally {
      await browser?.close();
      if (server) {
        const current = server;
        await new Promise<void>((resolve, reject) => {
          current.httpServer.close((error) => (error ? reject(error) : resolve()));
          if ('closeAllConnections' in current.httpServer) current.httpServer.closeAllConnections();
        });
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  90000,
);
