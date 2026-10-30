// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { build, type PreviewServer, preview } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { pythonCaseSources } from '../../../tests/conformance/support/python-cases.node.js';
import { pythonReloadCases } from '../../../tests/conformance/support/python-restore.js';
import { pythonStageACases } from '../../../tests/conformance/support/python-stage-a.js';
import {
  pythonStreamCases,
  pythonStreamComparison,
  pythonStreamProbes,
} from '../../../tests/conformance/support/python-streaming.js';
import { cspHeader } from '../src/host/csp.js';
import { missingPythonWheels, pythonWheelsAvailable } from './support/python.node.js';

// One shared build; each test boots at most one page, or two for reload/restore.
// Full coverage uses 39 page loads (including the fixed unknown-case failure).
describe.skipIf(!pythonWheelsAvailable)(
  pythonWheelsAvailable ? 'real Chromium Pyodide under strict CSP' : missingPythonWheels,
  () => {
    let directory: string;
    let server: PreviewServer | undefined;
    let browser: Browser | undefined;
    let context: BrowserContext;
    let page: Page;
    let origin: string;
    let pageLoads: number;
    let totalPageLoads = 0;
    let external: string[];
    let headers: string[];
    const header = cspHeader('mock');

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'galaxie-python-conformance-'));
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
        [
          ...pythonStageACases,
          ...pythonStreamCases,
          ...pythonStreamProbes,
          'parent-effects',
          'effect-scopes',
        ].map(async (name) => ({
          name,
          files: await pythonCaseSources(name),
        })),
      );
      {
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
        origin = `http://127.0.0.1:${address.port}`;
        browser = await chromium.launch({ headless: true });
      }
    }, 120000);
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
      expect(totalPageLoads).toBeLessThanOrEqual(39);
    });
    beforeEach(async () => {
      if (!browser) throw new Error('The conformance browser is missing.');
      context = await browser.newContext({ serviceWorkers: 'block' });
      external = [];
      headers = [];
      pageLoads = 0;
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      context.on('response', (response) =>
        headers.push(response.headers()['content-security-policy'] ?? ''),
      );
      page = await context.newPage();
    });
    afterEach(async () => {
      try {
        expect(pageLoads).toBeLessThanOrEqual(2);
        expect(external).toEqual([]);
        expect(headers.length).toBeGreaterThan(0);
        expect(headers.every((value) => value === header)).toBe(true);
      } finally {
        await context?.close();
      }
    });
    async function load(name: string, suffix = '') {
      pageLoads++;
      totalPageLoads++;
      await page.goto(`${origin}/?case=${name}${suffix}`);
      await page.waitForFunction(
        () => Reflect.get(globalThis, 'pythonConformance')?.done,
        undefined,
        { timeout: 60000 },
      );
      const result = await page.evaluate(() => Reflect.get(globalThis, 'pythonConformance'));
      expect(result.violations, name).toEqual([]);
      return result;
    }

    test('unknown case fails with a fixed message', async () => {
      const result = await load('unknown');
      expect(result.error).toBe('The conformance case is unknown.');
      expect(result.transcript).toBeUndefined();
    });
    test('preserves parent ordinals and full nested effect scopes', async () => {
      const result = await load('effect-scopes');
      expect(result.error).toBeUndefined();
      const actual = result.stream;
      expect(actual.error).toBeNull();
      expect(actual.effects).toHaveLength(3);
      expect(new Set(actual.effects).size).toBe(3);
      expect(actual.final).toEqual({ ids: actual.effects, answer: 'inner answer' });
      const data = actual.events.custom.map(({ data }: { data: unknown }) => data) as {
        scope: string;
        effectId: string;
      }[];
      expect(data).toHaveLength(6);
      expect(data.slice(3)).toEqual(data.slice(0, 3));
      expect(data.map(({ scope }) => scope.split('|').length)).toEqual([1, 1, 3, 1, 1, 3]);
      expect(data[2]?.scope).toMatch(/^parent:.*\|child:.*\|write:/);
      expect(result.scopes.capabilities).toHaveLength(6);
      expect(result.scopes.capabilities).toEqual(result.scopes.streams);
      expect(actual.replayModes).toEqual([]);
    }, 90000);
    test.each(pythonStageACases)(
      'native interrupts and counters: %s',
      async (name) => {
        const result = await load(name);
        expect(result.error, name).toBeUndefined();
        const golden = JSON.parse(
          await readFile(
            new URL(`../../../tests/conformance/golden-python/${name}.json`, import.meta.url),
            'utf8',
          ),
        );
        expect(result.transcript.pauses).toEqual(
          golden.pauses.map(({ interrupts }: { interrupts: unknown }) => ({ interrupts })),
        );
        expect(result.transcript.final).toEqual(golden.final);
        expect(result.transcript.final).toEqual(golden.state.values);
        expect(result.transcript.emptyPending).toBe(true);
        expect(result.transcript.stablePending).toBe(true);
        expect(result.transcript.repeated).toEqual([
          {
            type: 'error',
            error: { code: 'unsupported', message: 'This operation is unsupported.' },
          },
        ]);
      },
      90000,
    );
    test.each([...pythonStreamCases, ...pythonStreamProbes])(
      'native streams and checked deltas: %s',
      async (name) => {
        const result = await load(name);
        expect(result.error, name).toBeUndefined();
        const actual = result.stream;
        expect(actual.replayModes).toEqual([]);
        if ((pythonStreamCases as readonly string[]).includes(name)) {
          const golden = JSON.parse(
            await readFile(
              new URL(`../../../tests/conformance/golden-python/${name}.json`, import.meta.url),
              'utf8',
            ),
          );
          expect(actual.error, name).toEqual(
            name === 'model-failure'
              ? { code: 'unavailable', message: 'The requested service is unavailable.' }
              : name === 'step-limit'
                ? { code: 'budget_exceeded', message: 'The budget limit was reached.' }
                : null,
          );
          expect(pythonStreamComparison(name, actual.events), name).toEqual(
            pythonStreamComparison(name, golden.events),
          );
          expect(actual.modes, name).toEqual(golden.modes);
          expect(actual.final, name).toEqual(golden.final);
          expect(actual.pauses).toEqual(
            (golden.pauses ?? []).map(({ interrupts }: { interrupts: unknown }) => ({
              interrupts,
            })),
          );
          expect(actual.modelCalls).toBe(name.startsWith('model-') ? 1 : 0);
          expect(actual.capabilityCalls).toBe(name === 'capability' ? 1 : 0);
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
      },
      90000,
    );
    const reloads = [...pythonReloadCases, 'parent-effects'].flatMap((name) =>
      (name === 'interrupt-subgraph' ? [false] : [false, true]).map((accepted) => ({
        name,
        accepted,
      })),
    );
    test.each(reloads)(
      'reopens IndexedDB and restores $name (accepted=$accepted)',
      async ({ name, accepted }) => {
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
        const suffix = accepted ? '&accepted=1' : '';
        const initial = await load(name, `&durable=1${suffix}`);
        expect(initial.error, `${name}: start`).toBeUndefined();
        const restored = await load(
          name,
          `&durable=1&session=${initial.restore.sessionId}${suffix}`,
        );
        expect(restored.error, `${name}: restore`).toBeUndefined();
        if (!accepted) expect(restored.restore.pending).toEqual(initial.restore.pending);
        expect(restored.restore.final).toEqual(golden.final);
        expect(restored.restore.consumed).toBe(true);
        if (name === 'parent-effects') {
          expect(initial.restore.effects).toEqual({ bodies: 1, writes: 1 });
          expect(restored.restore.effects).toEqual({ bodies: 1, writes: 0 });
        }
      },
      150000,
    );
  },
);
