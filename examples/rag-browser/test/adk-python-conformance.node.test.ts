// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { build, type PreviewServer, preview } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { lockedWheels } from '../../../packages/adapter-pyodide/src/runtime-files.js';
import { adkPythonBrowserCases } from '../../../tests/conformance/support/adk-python.js';
import {
  type AdkReloadResult,
  adkPythonReloadCases,
  adkPythonWriteCases,
  joinAdkReload,
} from '../../../tests/conformance/support/adk-python-restore.js';
import {
  adkPythonSources,
  adkPythonWriteSources,
} from '../../../tests/conformance/support/adk-python-sources.node.js';
import { cspHeader } from '../src/host/csp.js';
import { missingPythonWheels, pythonWheelsAvailable } from './support/python.node.js';

describe.skipIf(!pythonWheelsAvailable)(
  pythonWheelsAvailable ? 'real Chromium ADK Python under strict CSP' : missingPythonWheels,
  () => {
    let directory: string;
    let server: PreviewServer | undefined;
    let browser: Browser | undefined;
    let origin: string;
    const header = cspHeader('mock');
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'galaxie-adk-python-conformance-'));
      const root = fileURLToPath(new URL('./support/adk-python-conformance/', import.meta.url));
      const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
      const outDir = join(directory, 'dist');
      const local = JSON.parse(
        await readFile(
          new URL('../../../.cache/python-wheels/local-wheels.json', import.meta.url),
          'utf8',
        ),
      );
      const sources = await Promise.all([
        ...[...new Set([...adkPythonBrowserCases, ...adkPythonReloadCases])].map(async (name) => ({
          name,
          files: await adkPythonSources(name),
        })),
        ...adkPythonWriteCases.map(async (name) => ({
          name,
          files: await adkPythonWriteSources(name),
        })),
      ]);
      const extraWheels = await Promise.all(
        lockedWheels
          .filter(
            (wheel) => wheel.frameworks?.includes('adk') && !wheel.frameworks.includes('langgraph'),
          )
          .map(async (wheel) => ({
            file: wheel.file,
            source: await readFile(
              new URL(`../../../.cache/python-wheels/${wheel.file}`, import.meta.url),
            ),
          })),
      );
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
              name: 'adk-python-conformance-assets',
              generateBundle() {
                for (const { name, files } of sources)
                  for (const [file, source] of Object.entries(files))
                    this.emitFile({
                      type: 'asset',
                      fileName: `conformance/${name}/${file}`,
                      source,
                    });
                for (const { file, source } of extraWheels)
                  this.emitFile({ type: 'asset', fileName: `python/wheels/${file}`, source });
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
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 180000);
    afterAll(async () => {
      try {
        await browser?.close();
        if (server) {
          const current = server;
          await new Promise<void>((resolve, reject) => {
            current.httpServer.close((error) => (error ? reject(error) : resolve()));
            if ('closeAllConnections' in current.httpServer)
              current.httpServer.closeAllConnections();
          });
        }
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    });
    test.each(adkPythonBrowserCases)(
      'Chromium matches native ADK Python requests and output: %s',
      async (name) => {
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
          await page.goto(`${origin}/?case=${name}`);
          await page.waitForFunction(
            () => Reflect.get(globalThis, 'adkPythonConformance')?.done,
            undefined,
            { timeout: 90000 },
          );
          const result = await page.evaluate(() => Reflect.get(globalThis, 'adkPythonConformance'));
          expect(result.error).toBeUndefined();
          expect(result.violations).toEqual([]);
          expect(result.transcript).toEqual(
            JSON.parse(
              await readFile(
                new URL(
                  `../../../tests/conformance/golden-adk-python/${name}.json`,
                  import.meta.url,
                ),
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
      120000,
    );

    async function reloadScenario(
      name: string,
      verify: (
        first: AdkReloadResult,
        reload: (step: Record<string, unknown>) => Promise<AdkReloadResult>,
      ) => Promise<void>,
      accepted = false,
    ): Promise<void> {
      if (!browser) throw new Error('The conformance browser is missing.');
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const external: string[] = [];
      const headers: string[] = [];
      let loads = 0;
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
        const observe = async (step?: Record<string, unknown>): Promise<AdkReloadResult> => {
          if (++loads > 4) throw new Error('The reload fixture exceeded its page-load bound.');
          if (step) {
            await page.evaluate(
              (value) => sessionStorage.setItem('adkReloadStep', JSON.stringify(value)),
              step,
            );
            await page.reload();
          } else
            await page.goto(`${origin}/?case=${name}&reload=1${accepted ? '&accepted=1' : ''}`);
          await page.waitForFunction(
            () => Reflect.get(globalThis, 'adkPythonConformance')?.done,
            undefined,
            { timeout: 90000 },
          );
          const result = await page.evaluate(() => Reflect.get(globalThis, 'adkPythonConformance'));
          expect(result.error).toBeUndefined();
          expect(result.violations).toEqual([]);
          if (!result.reload) throw new Error('The reload fixture produced no result.');
          return result.reload as AdkReloadResult;
        };
        await verify(await observe(), observe);
        expect(external).toEqual([]);
        expect(headers.length).toBeGreaterThan(0);
        expect(headers.every((value) => value === header)).toBe(true);
      } finally {
        await context.close();
      }
    }

    test.each(['confirm-approve', 'confirm-consecutive'] as const)(
      'Chromium reload with reopened IndexedDB matches native ADK Python: %s',
      async (name) => {
        await reloadScenario(name, async (first, reload) => {
          const steps = [first];
          let result = first;
          for (let index = 0; result.pending && index < 3; index++) {
            const before = result.pending;
            result = await reload({ name, sessionId: result.sessionId, answerIndex: index });
            expect(result.restored).toEqual(before);
            steps.push(result);
          }
          expect(result.pending).toBeUndefined();
          const golden = JSON.parse(
            await readFile(
              new URL(`../../../tests/conformance/golden-adk-python/${name}.json`, import.meta.url),
              'utf8',
            ),
          );
          expect(joinAdkReload(steps)).toEqual(golden);
          expect(result.consumed).toBe(true);
        });
      },
      180000,
    );

    test('Chromium replays a persisted write receipt after page reload', async () => {
      const name = 'approved-write';
      await reloadScenario(name, async (first, reload) => {
        expect(first.pending).toBeDefined();
        const lost = await reload({ name, sessionId: first.sessionId, crashAfterWrite: true });
        expect(lost.crashed).toBe(true);
        expect(lost.transcript.capabilities).toHaveLength(1);
        const restored = await reload({ name, sessionId: first.sessionId });
        expect(restored.transcript.error).toBeNull();
        expect(restored.transcript.output).toBe('done');
        expect(restored.transcript.capabilities).toEqual([]);
        expect(restored.consumed).toBe(true);
      });
    }, 180000);
  },
);
