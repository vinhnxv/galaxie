// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { build, type PreviewServer, preview } from 'vite';
import { expect, test } from 'vitest';
import { pythonCaseSources } from '../../../tests/conformance/support/python-cases.node.js';
import { pythonReloadCases } from '../../../tests/conformance/support/python-restore.js';
import { pythonStageACases } from '../../../tests/conformance/support/python-stage-a.js';
import {
  pythonStreamCases,
  pythonStreamProbes,
} from '../../../tests/conformance/support/python-streaming.js';
import { cspHeader } from '../src/host/csp.js';
import { missingPythonWheels, pythonWheelsAvailable } from './support/python.node.js';

test.skipIf(!pythonWheelsAvailable)(
  pythonWheelsAvailable
    ? 'real Chromium Pyodide matches native interrupts, restore and streams under strict CSP'
    : missingPythonWheels,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'galaxie-python-conformance-'));
    const root = fileURLToPath(new URL('./support/python-conformance/', import.meta.url));
    const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
    const outDir = join(directory, 'dist');
    const local = JSON.parse(
      await readFile(
        new URL('../../../.cache/python-wheels/local-wheels.json', import.meta.url),
        'utf8',
      ),
    );
    const sources = await Promise.all(
      [...pythonStageACases, ...pythonStreamCases, ...pythonStreamProbes, 'parent-effects'].map(
        async (name) => ({
          name,
          files: await pythonCaseSources(name),
        }),
      ),
    );
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
          define: { PYTHON_LOCAL_WHEELS: JSON.stringify(local.packages) },
          plugins: [
            {
              name: 'python-conformance-sources',
              generateBundle() {
                for (const { name, files } of sources)
                  for (const [file, source] of Object.entries(files))
                    this.emitFile({
                      type: 'asset',
                      fileName: `conformance/${name}/${file}`,
                      source,
                    });
              },
            },
          ],
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
        throw new Error('The conformance preview has no port.');
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
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
      const page = await context.newPage();
      for (const name of [...pythonStageACases, 'unknown']) {
        await page.goto(`${origin}/?case=${name}`);
        await page.waitForFunction(
          () => Reflect.get(globalThis, 'pythonConformance')?.done,
          undefined,
          { timeout: 60000 },
        );
        const result = await page.evaluate(() => Reflect.get(globalThis, 'pythonConformance'));
        expect(result.violations).toEqual([]);
        if (name === 'unknown') {
          expect(result.error).toBe('The conformance case is unknown.');
          expect(result.transcript).toBeUndefined();
          continue;
        }
        expect(result.error, name).toBeUndefined();
        const golden = JSON.parse(
          await readFile(
            new URL(`../../../tests/conformance/golden-python/${name}.json`, import.meta.url),
            'utf8',
          ),
        );
        expect(result.transcript.pauses, name).toEqual(
          golden.pauses.map(({ interrupts }: { interrupts: unknown }) => ({ interrupts })),
        );
        expect(result.transcript.final, name).toEqual(golden.final);
        expect(result.transcript.final, name).toEqual(golden.state.values);
        expect(result.transcript.emptyPending).toBe(true);
        expect(result.transcript.stablePending).toBe(true);
        expect(result.transcript.repeated).toEqual([
          {
            type: 'error',
            error: { code: 'unsupported', message: 'This operation is unsupported.' },
          },
        ]);
      }
      expect(external).toEqual([]);
      for (const name of [...pythonStreamCases, ...pythonStreamProbes]) {
        await page.goto(`${origin}/?case=${name}`);
        await page.waitForFunction(
          () => Reflect.get(globalThis, 'pythonConformance')?.done,
          undefined,
          { timeout: 60000 },
        );
        const result = await page.evaluate(() => Reflect.get(globalThis, 'pythonConformance'));
        expect(result.error, name).toBeUndefined();
        expect(result.violations, name).toEqual([]);
        const actual = result.stream;
        expect(actual.replayModes).toEqual([]);
        if ((pythonStreamCases as readonly string[]).includes(name)) {
          const golden = JSON.parse(
            await readFile(
              new URL(`../../../tests/conformance/golden-python/${name}.json`, import.meta.url),
              'utf8',
            ),
          );
          expect(actual.error, name).toBeNull();
          expect(actual.events, name).toEqual(golden.events);
          expect(actual.modes, name).toEqual(golden.modes);
          expect(actual.final, name).toEqual(golden.final);
        } else if (name === 'allow') {
          expect(actual.error).toBeNull();
          expect(actual.final).toEqual({
            text: 'allowed BLOCKED LATER',
            usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
          });
          expect(actual.checks.at(-1)).toEqual({ text: 'allowed BLOCKED LATER', final: true });
        } else if (name === 'cancel') {
          expect(actual.cancelled).toBe(true);
          expect(actual.final).toBeNull();
          expect(actual.events.custom).toEqual([{ path: [], data: { seen: 'allowed ' } }]);
          expect(JSON.stringify(actual.events)).not.toContain('BLOCKED');
          expect(JSON.stringify(actual.events)).not.toContain('LATER');
        } else if (name === 'close') {
          expect(actual.closedWhileRunning).toBe(true);
          expect(actual.error).toBeNull();
          expect(actual.final).toEqual({ text: 'allowed ', usage: null });
          expect(actual.nextRunOutput).toEqual({
            text: 'allowed BLOCKED LATER',
            usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
          });
        } else if (name === 'block' || name === 'close-block') {
          expect(actual.error).toEqual({ code: 'denied', message: 'Policy denied the request.' });
          expect(actual.events.custom).toEqual([
            { path: [], data: name === 'block' ? { seen: 'allowed ' } : { closed: true } },
          ]);
          expect(JSON.stringify(actual.events)).not.toContain('BLOCKED');
          expect(JSON.stringify(actual.events)).not.toContain('LATER');
        } else {
          expect(actual.error).toEqual({
            code: 'unsupported',
            message: 'This operation is unsupported.',
          });
          expect(JSON.stringify(actual.events)).not.toContain('UNSUPPORTED-PRIVATE');
        }
      }
      for (const name of [...pythonReloadCases, 'parent-effects']) {
        const golden =
          name === 'parent-effects'
            ? { final: { value: 1, answer: { answer: 'yes' }, saved: true } }
            : JSON.parse(
                await readFile(
                  new URL(
                    `../../../tests/conformance/golden-python/reload/${name}.json`,
                    import.meta.url,
                  ),
                  'utf8',
                ),
              );
        for (const accepted of [false, true]) {
          const suffix = accepted ? '&accepted=1' : '';
          await page.goto(`${origin}/?case=${name}&durable=1${suffix}`);
          await page.waitForFunction(
            () => Reflect.get(globalThis, 'pythonConformance')?.done,
            undefined,
            { timeout: 60000 },
          );
          const initial = await page.evaluate(() => Reflect.get(globalThis, 'pythonConformance'));
          expect(initial.error, `${name}: start`).toBeUndefined();
          expect(initial.violations, `${name}: start accepted=${accepted}`).toEqual([]);
          await page.goto(
            `${origin}/?case=${name}&durable=1&session=${initial.restore.sessionId}${suffix}`,
          );
          await page.waitForFunction(
            () => Reflect.get(globalThis, 'pythonConformance')?.done,
            undefined,
            { timeout: 60000 },
          );
          const restored = await page.evaluate(() => Reflect.get(globalThis, 'pythonConformance'));
          expect(restored.error, `${name}: restore`).toBeUndefined();
          expect(restored.violations).toEqual([]);
          if (!accepted) expect(restored.restore.pending).toEqual(initial.restore.pending);
          expect(restored.restore.final, name).toEqual(golden.final);
          expect(restored.restore.consumed).toBe(true);
          if (name === 'parent-effects') {
            expect(initial.restore.effects).toEqual({ bodies: 1, writes: 1 });
            expect(restored.restore.effects).toEqual({ bodies: 1, writes: 0 });
          }
        }
      }
      expect(external).toEqual([]);
      expect(headers.length).toBeGreaterThan(5);
      expect(headers.every((value) => value === header)).toBe(true);
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
  // About 28 page loads each boot Pyodide; hosted runners take roughly ten seconds per boot.
  600000,
);
