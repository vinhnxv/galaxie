// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import { build, type PreviewServer, preview } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { lockedWheels } from '../../../packages/adapter-pyodide/src/runtime-files.js';
import { pydanticCases } from '../../../tests/conformance/support/pydantic-ai.js';
import {
  childApprovalCases,
  joinChildApprovalTranscripts,
} from '../../../tests/conformance/support/pydantic-ai-child-approval-conformance.js';
import { childApprovalSuiteSources } from '../../../tests/conformance/support/pydantic-ai-child-approval-suite-sources.node.js';
import {
  delegationCases,
  joinDelegationTranscripts,
} from '../../../tests/conformance/support/pydantic-ai-delegation-conformance.js';
import { delegationSuiteSources } from '../../../tests/conformance/support/pydantic-ai-delegation-suite-sources.node.js';
import {
  joinPydanticReload,
  type PydanticReloadResult,
  type PydanticReloadStep,
  pydanticReloadCases,
} from '../../../tests/conformance/support/pydantic-ai-restore.js';
import { pydanticSources } from '../../../tests/conformance/support/pydantic-ai-sources.node.js';
import { cspHeader } from '../src/host/csp.js';
import type { SuiteResult } from './support/pydantic-ai-conformance/suites.js';
import { missingPythonWheels, pythonWheelsAvailable } from './support/python.node.js';

type BrowserReloadStep = PydanticReloadStep & {
  readonly fault?: 'logout' | 'takeover' | 'corrupt' | 'executor' | 'completion' | 'orphan';
};
interface BrowserReloadObservation {
  readonly reload?: PydanticReloadResult;
  readonly error?: string;
  readonly errorCode?: string;
  readonly storageEmpty?: boolean;
  readonly controlReadable?: boolean;
  readonly checkpointReads?: number;
  readonly exportPendingCount?: number;
  readonly exportExecutor?: string;
}

describe.skipIf(!pythonWheelsAvailable)(
  pythonWheelsAvailable ? 'real Chromium pydantic-ai under strict CSP' : missingPythonWheels,
  () => {
    let directory: string;
    let server: PreviewServer | undefined;
    let browser: Browser | undefined;
    let origin: string;
    let pageLoads = 0;
    let suiteLoads = 0;
    const header = cspHeader('mock');
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'galaxie-pydantic-conformance-'));
      const root = fileURLToPath(new URL('./support/pydantic-ai-conformance/', import.meta.url));
      const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
      const outDir = join(directory, 'dist');
      const local = JSON.parse(
        await readFile(
          new URL('../../../.cache/python-wheels/local-wheels.json', import.meta.url),
          'utf8',
        ),
      );
      const sources = await Promise.all(
        [...pydanticCases, 'approved-write', 'resumed-write'].map(async (name) => ({
          name,
          files: await pydanticSources(name),
        })),
      );
      sources.push(
        ...(await Promise.all(
          delegationCases.map(async (name) => ({
            name,
            files: await delegationSuiteSources(name),
          })),
        )),
        ...(await Promise.all(
          childApprovalCases.map(async (name) => ({
            name,
            files: await childApprovalSuiteSources([name]),
          })),
        )),
      );
      const extraWheels = await Promise.all(
        lockedWheels
          .filter(
            (wheel) =>
              wheel.frameworks?.includes('pydantic-ai') && !wheel.frameworks.includes('langgraph'),
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
              name: 'pydantic-conformance-assets',
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
    }, 900000);
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
      const reloadPageLimit = pydanticReloadCases.reduce(
        (total, name) => total + (name === 'approval-consecutive' ? 3 : 2),
        2 + 3 * 3 + 10,
      );
      expect(pageLoads).toBeLessThanOrEqual(pydanticCases.length + reloadPageLimit);
      expect(suiteLoads).toBeLessThanOrEqual(8);
    });
    test.each(pydanticCases)(
      'Chromium matches native pydantic-ai requests and output: %s',
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
          pageLoads++;
          await page.goto(`${origin}/?case=${name}`);
          await page.waitForFunction(
            () => Reflect.get(globalThis, 'pydanticConformance')?.done,
            undefined,
            { timeout: 60000 },
          );
          const result = await page.evaluate(() => Reflect.get(globalThis, 'pydanticConformance'));
          expect(result.error).toBeUndefined();
          expect(result.violations).toEqual([]);
          expect(result.transcript).toEqual(
            JSON.parse(
              await readFile(
                new URL(
                  `../../../tests/conformance/golden-pydantic-ai/${name}.json`,
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
      90000,
    );

    async function suiteScenario(
      suite: 'delegation' | 'child-approval',
      name: string,
      reload: boolean,
    ): Promise<void> {
      if (!browser) throw new Error('The conformance browser is missing.');
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const external: string[] = [];
      const headers: string[] = [];
      const pageErrors: string[] = [];
      const results: SuiteResult[] = [];
      const started = performance.now();
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
        page.on('pageerror', (error) => pageErrors.push(error.message));
        const observe = async (sessionId?: string): Promise<SuiteResult> => {
          if (++loads > (reload ? 2 : 1))
            throw new Error('The suite fixture exceeded its page-load bound.');
          suiteLoads++;
          if (sessionId === undefined) await page.goto(`${origin}/?suite=${suite}&case=${name}`);
          else {
            await page.evaluate(
              (value) => sessionStorage.setItem('pydanticSuiteStep', JSON.stringify(value)),
              { sessionId },
            );
            await page.reload();
          }
          await page.waitForFunction(
            () => Reflect.get(globalThis, 'pydanticConformance')?.done,
            undefined,
            { timeout: 600000 },
          );
          const result = await page.evaluate(() => Reflect.get(globalThis, 'pydanticConformance'));
          expect(result.error).toBeUndefined();
          expect(result.violations).toEqual([]);
          expect(result.workerErrors).toEqual([]);
          const observed = result.suite as SuiteResult;
          expect(observed.suite).toBe(suite);
          expect(observed.case).toBe(name);
          expect(observed.workers).toEqual({ created: 1, terminated: 1 });
          expect(observed.lifetime.streams.events).toBeGreaterThan(0);
          expect(observed.lifetime.streams.nonEmptyPaths).toBe(0);
          expect(observed.subgraphs).toBe(false);
          results.push(observed);
          return observed;
        };
        const first = await observe();
        if (reload) {
          expect(first.lifetime.pending).toBeDefined();
          expect(first.effects).toBe(0);
          const second = await observe(first.lifetime.sessionId);
          expect(second.lifetime.restored).toEqual(first.lifetime.pending);
          expect(second.lifetime.pending).toBeUndefined();
          expect(results.map((value) => value.lifetime.writes)).toEqual([0, 1]);
        }
        const transcripts = results.map((value) => value.lifetime.transcript);
        const transcript =
          suite === 'delegation'
            ? joinDelegationTranscripts(transcripts)
            : joinChildApprovalTranscripts(transcripts);
        expect(transcript).toEqual(
          JSON.parse(
            await readFile(
              new URL(
                `../../../tests/conformance/golden-pydantic-ai-${suite}/${name}.json`,
                import.meta.url,
              ),
              'utf8',
            ),
          ),
        );
        const bridge = results.flatMap((value) => value.bridge);
        const writes = bridge.filter((value) => value.op === 'capability');
        const expectedWrites = reload || name === 'child-approval-approve' ? 1 : 0;
        expect(results.at(-1)?.effects).toBe(expectedWrites);
        expect(writes).toHaveLength(expectedWrites);
        if (suite === 'child-approval') {
          expect(bridge.filter((value) => value.op === 'model').map((value) => value.role)).toEqual(
            name === 'child-approval-reject'
              ? ['parent', 'child', 'parent']
              : ['parent', 'child', 'child', 'parent'],
          );
          if (expectedWrites)
            expect(writes[0]?.effectScope).toMatch(/^pydantic-ai\/[0-9a-f]{64}\/\d+\/\d+$/);
        }
        if (name === 'delegation-nested-plain-refused')
          expect(bridge.some((value) => value.role === 'child')).toBe(false);
        expect(pageErrors).toEqual([]);
        expect(external).toEqual([]);
        expect(headers.length).toBeGreaterThan(0);
        expect(headers.every((value) => value === header)).toBe(true);
        console.info(
          `Chromium ${name}: ${Math.round(performance.now() - started)} ms, ${loads} loads`,
        );
      } finally {
        await context.close();
      }
    }

    test.each([
      ['delegation', 'delegation-shared-budgets'],
      ['delegation', 'delegation-nested-plain-refused'],
      ['child-approval', 'child-approval-approve'],
      ['child-approval', 'child-approval-reject'],
    ] as const)(
      'Chromium delegation suite matches native in one lifetime: %s / %s',
      async (suite, name) => suiteScenario(suite, name, false),
      900000,
    );
    test.each([
      ['delegation', 'delegation-reload-write'],
      ['child-approval', 'child-approval-restore'],
    ] as const)(
      'Chromium delegation suite matches native across page reload: %s / %s',
      async (suite, name) => suiteScenario(suite, name, true),
      900000,
    );

    async function reloadScenario(
      name: string,
      verify: (
        first: PydanticReloadResult,
        reload: (step: BrowserReloadStep) => Promise<PydanticReloadResult>,
        observe: (step: BrowserReloadStep) => Promise<BrowserReloadObservation>,
        initial: BrowserReloadObservation,
      ) => Promise<void>,
      accepted = false,
      fault?: BrowserReloadStep['fault'],
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
        const page: Page = await context.newPage();
        const observe = async (step?: BrowserReloadStep): Promise<BrowserReloadObservation> => {
          if (++loads > 3) throw new Error('The reload fixture exceeded its page-load bound.');
          pageLoads++;
          if (step) {
            await page.evaluate(
              (value) => sessionStorage.setItem('pydanticReloadStep', JSON.stringify(value)),
              step,
            );
            await page.reload();
          } else
            await page.goto(
              `${origin}/?case=${name}&reload=1${accepted ? '&accepted=1' : ''}${fault ? `&fault=${fault}` : ''}`,
            );
          await page.waitForFunction(
            () => Reflect.get(globalThis, 'pydanticConformance')?.done,
            undefined,
            { timeout: 60000 },
          );
          const result = await page.evaluate(() => Reflect.get(globalThis, 'pydanticConformance'));
          expect(result.violations).toEqual([]);
          return result as BrowserReloadObservation;
        };
        const checked = (result: BrowserReloadObservation): PydanticReloadResult => {
          expect(result.error).toBeUndefined();
          if (!result.reload) throw new Error('The reload fixture produced no result.');
          return result.reload;
        };
        const initial = await observe();
        await verify(
          checked(initial),
          async (step) => checked(await observe(step)),
          observe,
          initial,
        );
        expect(external).toEqual([]);
        expect(headers.length).toBeGreaterThan(0);
        expect(headers.every((value) => value === header)).toBe(true);
      } finally {
        await context.close();
      }
    }

    test.each(pydanticReloadCases)(
      'Chromium reload with reopened IndexedDB matches native pydantic-ai: %s',
      async (name) => {
        await reloadScenario(name, async (first, reload) => {
          const steps = [first];
          let result = first;
          for (let index = 0; result.pending && index < 2; index++) {
            const before = result.pending;
            result = await reload({ name, sessionId: result.sessionId, answerIndex: index });
            expect(result.restored).toEqual(before);
            steps.push(result);
          }
          expect(result.pending).toBeUndefined();
          const golden = JSON.parse(
            await readFile(
              new URL(
                `../../../tests/conformance/golden-pydantic-ai/${name}.json`,
                import.meta.url,
              ),
              'utf8',
            ),
          );
          expect(joinPydanticReload(steps)).toEqual(golden);
          if (result.transcript.error === null) expect(result.consumed).toBe(true);
        });
      },
      120000,
    );

    test('Chromium reconciles an accepted answer after page reload and IndexedDB reopen', async () => {
      const name = 'approval-approve';
      await reloadScenario(
        name,
        async (first, reload) => {
          expect(first.pending).toBeDefined();
          const restored = await reload({ name, sessionId: first.sessionId });
          expect(restored.restored).toBeUndefined();
          expect(restored.transcript.error).toBeNull();
          expect(restored.transcript.output).toBe('The deferred result is ready.');
          expect(restored.transcript.capabilities).toHaveLength(1);
          expect(restored.consumed).toBe(true);
        },
        true,
      );
    }, 120000);

    test.each(['approved-write', 'resumed-write', 'changed-write'] as const)(
      'Chromium replays a persisted write receipt after page reload: %s',
      async (probe) => {
        const name = probe === 'changed-write' ? 'resumed-write' : probe;
        await reloadScenario(name, async (first, reload) => {
          expect(first.pending).toBeDefined();
          expect(first.transcript.capabilities).toEqual([]);
          const lost = await reload({ name, sessionId: first.sessionId, crashAfterWrite: true });
          expect(lost.restored).toEqual(first.pending);
          expect(lost.crashed).toBe(true);
          expect(lost.transcript.capabilities).toHaveLength(1);
          expect(lost.consumed).toBe(false);
          const restored = await reload({
            name,
            sessionId: first.sessionId,
            ...(probe === 'changed-write' ? { changedWrite: true } : {}),
          });
          expect(restored.transcript.capabilities).toEqual([]);
          if (probe === 'changed-write') {
            expect(restored.transcript.error).toMatchObject({ code: 'unrecoverable' });
            expect(restored.transcript.output).toBeNull();
          } else {
            expect(restored.transcript.error).toBeNull();
            expect(restored.transcript.output).toBe('done');
            expect(restored.consumed).toBe(true);
          }
        });
      },
      120000,
    );

    test.each(['logout', 'takeover'] as const)(
      'Chromium fences a pydantic-ai checkpoint after %s',
      async (fault) => {
        await reloadScenario(
          'approval-approve',
          async (first, _reload, _observe, initial) => {
            expect(first.transcript.error).toMatchObject({
              code: fault === 'logout' ? 'stale' : 'fenced',
            });
            expect(first.pending).toBeUndefined();
            expect(first.transcript.capabilities).toEqual([]);
            expect(initial.storageEmpty).toBe(true);
          },
          false,
          fault,
        );
      },
      90000,
    );

    test('Chromium refuses a corrupt conversation after reload and leaves another session readable', async () => {
      const name = 'approval-approve';
      await reloadScenario(name, async (first, _reload, observe) => {
        expect(first.pending).toBeDefined();
        const failed = await observe({ name, sessionId: first.sessionId, fault: 'corrupt' });
        expect(failed.errorCode).toBe('unrecoverable');
        expect(failed.error).toBe('Stored state cannot be recovered.');
        expect(failed.controlReadable).toBe(true);
        expect(failed.checkpointReads).toBeGreaterThan(0);
      });
    }, 90000);

    test('Chromium refuses a stored LangGraph Python session before reading pydantic-ai checkpoints', async () => {
      const name = 'approval-approve';
      await reloadScenario(name, async (_first, _reload, observe) => {
        const failed = await observe({
          name,
          sessionId: '00000000-0000-4000-8000-000000000001',
          fault: 'executor',
        });
        expect(failed.errorCode).toBe('unsupported');
        expect(failed.error).toBe('The saved session uses a different executor.');
        expect(failed.checkpointReads).toBe(0);
      });
    }, 90000);

    test('Chromium retries a failed completion commit in the same Worker without repeating its write', async () => {
      const name = 'approved-write';
      await reloadScenario(
        name,
        async (first, _reload, observe) => {
          const retried = await observe({
            name,
            sessionId: first.sessionId,
            fault: 'completion',
            restoreAfterError: true,
          });
          expect(retried.error).toBeUndefined();
          expect(retried.reload?.transcript.error).toEqual({
            code: 'unavailable',
            message: 'The requested service is unavailable.',
          });
          expect(retried.reload?.retriedOutput).toBe('done');
          expect(retried.reload?.transcript.capabilities).toHaveLength(1);
          expect(retried.reload?.consumed).toBe(true);
          expect(retried.exportPendingCount).toBe(0);
          expect(retried.exportExecutor).toBe('pydantic-ai-python');
        },
        true,
      );
    }, 90000);

    test('Chromium completion replaces an orphan interrupt marker from a failed pause commit', async () => {
      const name = 'approval-approve';
      await reloadScenario(name, async (first, _reload, observe) => {
        const completed = await observe({ name, sessionId: first.sessionId, fault: 'orphan' });
        expect(completed.error).toBeUndefined();
        expect(completed.reload?.transcript.error).toBeNull();
        expect(completed.reload?.transcript.output).toBe('The deferred result is ready.');
        expect(completed.reload?.consumed).toBe(true);
        expect(completed.exportPendingCount).toBe(0);
        expect(completed.exportExecutor).toBe('pydantic-ai-python');
      });
    }, 90000);
  },
);
