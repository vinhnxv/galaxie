// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import type { Browser, Page, Response } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import fixtures from '../../../tests/conformance/cases-dspy/engine-fixtures.json' with {
  type: 'json',
};
import failures from '../../../tests/conformance/dspy-engine-known-failures.json' with {
  type: 'json',
};
import { type DspyTranscript, dspyCases } from '../../../tests/conformance/support/dspy.js';
import { branchSources } from '../../../tests/conformance/support/dspy-branches-sources.node.js';
import {
  parallelAnswers,
  parallelScenarios,
} from '../../../tests/conformance/support/dspy-parallel.js';
import { parallelSources } from '../../../tests/conformance/support/dspy-parallel-sources.node.js';
import type { ParallelResult } from '../../../tests/conformance/support/dspy-parallel-step.js';
import {
  type DspyReloadResult,
  type DspyReloadStep,
  dspyRejectedRestoreCases,
  dspyReloadCases,
} from '../../../tests/conformance/support/dspy-restore.js';
import { dspySources } from '../../../tests/conformance/support/dspy-sources.node.js';
import { dspyStateCases } from '../../../tests/conformance/support/dspy-state.js';
import { stateBindScenarios } from '../../../tests/conformance/support/dspy-state-bind.js';
import { expectedBinding } from '../../../tests/conformance/support/dspy-state-binding.js';
import { stateRestoreScenarios } from '../../../tests/conformance/support/dspy-state-restore.js';
import { stateRestoreSources } from '../../../tests/conformance/support/dspy-state-restore-sources.node.js';
import {
  buildDspyPage,
  dspyEngine,
  dspyHeader,
  launchDspyEngine,
  selectDspyEngine,
} from './support/dspy-engine.node.js';

type BuiltPage = Awaited<ReturnType<typeof buildDspyPage>>;
let browser: Browser;
let live: BuiltPage;
let state: BuiltPage;
let engine: BuiltPage;
const pages: BuiltPage[] = [];
let booted = false;

function recordHeader(response: Response, headers: string[]): void {
  const value = response.headers()['content-security-policy'] ?? '';
  headers.push(value);
  if (value !== dspyHeader)
    console.info(
      JSON.stringify({
        engine: dspyEngine,
        cspMismatch: { url: response.url(), status: response.status(), header: value },
      }),
    );
}

beforeAll(async () => {
  const liveCases: Record<string, Record<string, string>> = {
    predict: await dspySources('predict'),
  };
  if (dspyEngine !== 'chromium') {
    for (const name of fixtures.fanout.filter((name) => name !== 'fanout-reload'))
      liveCases[name] = await dspySources(name);
    liveCases['fanout-reload'] = await branchSources('par-fan-two-stage-single');
  }
  live = await buildDspyPage(new URL('./support/dspy-conformance/', import.meta.url), liveCases);
  pages.push(live);
  if (dspyEngine !== 'chromium') {
    const stateCases: Record<string, Record<string, string>> = {};
    for (const scenario of stateBindScenarios.filter((value) => value.lanes.includes('chromium'))) {
      for (const lifetime of ['pause', 'resume'] as const)
        stateCases[scenario.name + (lifetime === 'resume' ? '-resume' : '')] =
          await stateRestoreSources({ ...scenario, outcome: scenario.predicted }, lifetime);
    }
    state = await buildDspyPage(
      new URL('./support/dspy-state-conformance/', import.meta.url),
      stateCases,
    );
    pages.push(state);
  }
  const repause = { ...(await dspySources('durable-two')), 'unrelated.json': '{}' };
  const engineCases: Record<string, Record<string, string>> = {
    'bind-legacy-repause': repause,
    'bind-legacy-repause-changed': { ...repause, 'unrelated.json': '[]' },
  };
  for (const name of fixtures.threadPool) engineCases[name] = await parallelSources(name);
  engine = await buildDspyPage(new URL('./support/dspy-engine/', import.meta.url), engineCases);
  pages.push(engine);
  browser = await launchDspyEngine();
  console.info(JSON.stringify({ engine: dspyEngine, version: browser.version() }));
}, 900000);

afterAll(async () => {
  await browser?.close();
  for (const page of pages) await page.close();
}, 900000);

function engineTest(description: string, run: () => Promise<void>, requiresBoot = true): void {
  const title = `${dspyEngine} ${description}`;
  const registered: readonly string[] = failures[dspyEngine];
  const register = registered.includes(title) ? test.fails : test;
  register(
    title,
    async (context) => {
      if (requiresBoot && !booted) context.skip();
      await run();
    },
    900000,
  );
}

async function withPage(origin: string, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const external: string[] = [],
    headers: string[] = [];
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  context.on('response', (response) => recordHeader(response, headers));
  try {
    await run(await context.newPage());
    expect(external).toEqual([]);
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((value) => value === dspyHeader)).toBe(true);
  } finally {
    await context.close();
  }
}

async function result<T>(
  page: Page,
  key: string,
): Promise<T & { error?: string; errorCode?: string; violations: string[] }> {
  await page.waitForFunction((key) => Reflect.get(globalThis, key)?.done, key, { timeout: 300000 });
  return page.evaluate((key) => Reflect.get(globalThis, key), key);
}

engineTest(
  'boots DSPy predict under strict CSP',
  async () => {
    await withPage(live.origin, async (page) => {
      await page.goto(`${live.origin}/?case=predict`);
      const measured = await result<{ transcript: DspyTranscript }>(page, 'dspyConformance');
      expect(measured.error).toBeUndefined();
      expect(measured.violations).toEqual([]);
      expect(measured.transcript).toEqual(
        JSON.parse(
          await readFile(
            new URL('../../../tests/conformance/golden-dspy/predict.json', import.meta.url),
            'utf8',
          ),
        ),
      );
      console.info(
        JSON.stringify({
          engine: dspyEngine,
          premise: await page.evaluate(() => ({
            trustedTypes: typeof Reflect.get(globalThis, 'trustedTypes'),
            WebAssembly: typeof WebAssembly,
            indexedDB: typeof indexedDB,
          })),
          moduleWorker: 'PASS: executor ran in a module Worker',
        }),
      );
    });
    booted = true;
  },
  false,
);

test('engine scenario names are unique across existing DSPy families', () => {
  const names = fixtures.scenarios.map((scenario) => scenario.name);
  const existing = [
    ...dspyCases,
    ...dspyReloadCases,
    ...dspyRejectedRestoreCases,
    ...dspyStateCases,
    ...stateBindScenarios.map((scenario) => scenario.name),
    ...stateRestoreScenarios.map((scenario) => scenario.name),
    ...parallelScenarios,
  ];
  expect(new Set(names).size).toBe(names.length);
  expect(names.filter((name) => existing.includes(name))).toEqual([]);
}, 900000);

test('engine selection refuses unknown names with the configuration error', () => {
  expect(selectDspyEngine()).toBe('chromium');
  expect(() => selectDspyEngine('unknown')).toThrow(
    'GALAXIE_BROWSER must be one of chromium, firefox, webkit, not "unknown".',
  );
}, 900000);

test('answers revalidation with the strict CSP header', async () => {
  const url = `${engine.origin}/conformance/bind-legacy-repause/unrelated.json`;
  const initial = await fetch(url);
  expect(initial.status).toBe(200);
  expect(initial.headers.get('content-security-policy')).toBe(dspyHeader);
  const etag = initial.headers.get('etag');
  expect(etag, 'The preview must supply an ETag for conditional revalidation.').toBeTruthy();
  await initial.arrayBuffer();
  const revalidated = await fetch(url, { headers: { 'If-None-Match': etag ?? '' } });
  expect(revalidated.status).toBe(304);
  expect(revalidated.headers.get('content-security-policy')).toBe(dspyHeader);
}, 900000);

async function reloadResult(page: Page): Promise<{
  reload: DspyReloadResult;
  bindTraffic?: { models: number; capabilities: number; replayed: number };
  error?: string;
  errorCode?: string;
  violations: string[];
}> {
  return result(page, 'dspyStateConformance');
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

engineTest('binds a legacy session when it pauses again', async () => {
  await withPage(engine.origin, async (page) => {
    await page.goto(`${engine.origin}/?case=bind-legacy-repause&mode=repause`);
    const read = (): Promise<{
      reload: DspyReloadResult;
      bindTraffic: { models: number; capabilities: number; replayed: number };
      workerErrors: string[];
      error?: string;
      errorCode?: string;
      violations: string[];
    }> => result(page, 'dspyEngineConformance');
    const next = async (sessionId: string, changed = false): ReturnType<typeof read> => {
      await page.evaluate(
        (step) => sessionStorage.setItem('dspyEngineStep', JSON.stringify(step)),
        { name: 'durable-two', sessionId, changed },
      );
      await page.reload();
      return read();
    };
    const first = await read();
    expect(first.error).toBeUndefined();
    expect(first.reload.error).toBeUndefined();
    expect(first.reload.pending).toBeDefined();
    expect(first.reload.calls).toEqual(['before']);
    expect(first.reload.requests).toBe(0);
    expect(first.violations).toEqual([]);
    expect(first.workerErrors).toEqual([]);
    const sources = { ...(await dspySources('durable-two')), 'unrelated.json': '{}' };
    expect(await storedBindings(page, true, 'dspy-engine-repause')).toEqual([
      expectedBinding(sources),
    ]);
    expect(await storedBindings(page, false, 'dspy-engine-repause')).toEqual([]);
    const second = await next(first.reload.sessionId);
    expect(second.error).toBeUndefined();
    expect(second.reload.error).toBeUndefined();
    expect(second.reload.restored).toEqual(first.reload.pending);
    expect(second.reload.pending).toBeDefined();
    expect(second.reload.pending?.viewRevision).toBe('second');
    expect(second.reload.pending?.interactionId).not.toBe(first.reload.pending?.interactionId);
    expect(second.reload.calls).toEqual([]);
    expect(second.reload.requests).toBe(0);
    expect(second.bindTraffic).toEqual({ models: 0, capabilities: 0, replayed: 1 });
    expect(second.violations).toEqual([]);
    expect(second.workerErrors).toEqual([]);
    expect(await storedBindings(page, false, 'dspy-engine-repause')).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    expect(await storedBindings(page, false, 'dspy-engine-repause')).toEqual([
      expectedBinding(sources),
    ]);
    const saved = await bindingStore(page, 'dspy-engine-repause');
    const refused = await next(first.reload.sessionId, true);
    expect(refused.errorCode).toBe('unrecoverable');
    expect(refused.error).toBe('Stored state cannot be recovered.');
    expect(refused.reload).toBeUndefined();
    expect(refused.bindTraffic).toEqual({ models: 0, capabilities: 0, replayed: 0 });
    expect(refused.violations).toEqual([]);
    expect(refused.workerErrors).toEqual([]);
    expect(await bindingStore(page, 'dspy-engine-repause')).toBe(saved);
    const rollback = await next(first.reload.sessionId);
    expect(rollback.error).toBeUndefined();
    expect(rollback.reload.error).toBeUndefined();
    expect(rollback.reload.restored).toEqual(second.reload.pending);
    expect(rollback.reload.pending).toBeUndefined();
    expect(rollback.reload.output).toEqual({
      answer: 'done',
      receipt: 'RESTORED_CAPABILITY_SECRET',
    });
    expect(rollback.reload.calls).toEqual([]);
    expect(rollback.reload.requests).toBe(1);
    expect(rollback.reload.consumed).toBe(true);
    expect(rollback.bindTraffic).toEqual({ models: 1, capabilities: 0, replayed: 1 });
    expect(rollback.violations).toEqual([]);
    expect(rollback.workerErrors).toEqual([]);
  });
});

// Run thread-start first: actual threads would invalidate the single-thread premise.
for (const name of fixtures.threadPool)
  engineTest(`measures thread-pool refusal: ${name}`, async () => {
    await withPage(engine.origin, async (page) => {
      await page.goto(`${engine.origin}/?case=${name}&mode=parallel`);
      const measured = await result<{ parallel: ParallelResult; workerErrors: string[] }>(
        page,
        'dspyEngineConformance',
      );
      expect(measured.error).toBeUndefined();
      expect(measured.workerErrors).toEqual([]);
      expect(measured.violations).toEqual([]);
      if (name === 'par-verbatim-thread-start') {
        expect(measured.parallel.output).toEqual({ thread: 'RuntimeError', pool: 'RuntimeError' });
        expect(measured.parallel.error).toBeUndefined();
      } else {
        expect(measured.parallel.error).toEqual({
          code: 'unsupported',
          message: 'This operation is unsupported.',
        });
        expect(measured.parallel.output).toBeUndefined();
      }
      expect(measured.parallel.modelLabels).toEqual([]);
      expect(measured.parallel.calls).toEqual([]);
      expect(measured.parallel.postTerminationRequests).toBe(0);
    });
  });

if (dspyEngine !== 'chromium') {
  for (const name of fixtures.fanout.filter((name) => name !== 'fanout-reload'))
    engineTest(`matches the live native golden: ${name}`, async () => {
      await withPage(live.origin, async (page) => {
        await page.goto(`${live.origin}/?case=${name}`);
        const measured = await result<{ transcript: DspyTranscript }>(page, 'dspyConformance');
        expect(measured.error).toBeUndefined();
        expect(measured.violations).toEqual([]);
        expect(measured.transcript).toEqual(
          JSON.parse(
            await readFile(
              new URL(`../../../tests/conformance/golden-dspy/${name}.json`, import.meta.url),
              'utf8',
            ),
          ),
        );
      });
    });
  engineTest('replays a joined fanout after a real IndexedDB reload: fanout-reload', async () => {
    await withPage(live.origin, async (page) => {
      await page.goto(`${live.origin}/?case=fanout-reload`);
      const read = (): Promise<{
        branches: ParallelResult;
        error?: string;
        violations: string[];
      }> => result(page, 'dspyConformance');
      const first = await read();
      expect(first.error).toBeUndefined();
      expect(first.branches.error).toBeUndefined();
      expect(first.branches.pending).toBeDefined();
      expect(first.branches.modelLabels.sort()).toEqual([
        'alpha:before',
        'beta:before',
        'gamma:before',
      ]);
      expect(first.violations).toEqual([]);
      await page.evaluate(
        (sessionId) =>
          sessionStorage.setItem(
            'dspyBranchStep',
            JSON.stringify({ name: 'par-fan-two-stage-single', sessionId, order: 'reversed' }),
          ),
        first.branches.sessionId,
      );
      await page.reload();
      const resumed = await read();
      expect(resumed.error).toBeUndefined();
      expect(resumed.branches.error).toBeUndefined();
      expect(resumed.branches.restored).toEqual(first.branches.pending);
      expect(resumed.branches.modelLabels.sort()).toEqual([
        'alpha:after',
        'beta:after',
        'gamma:after',
      ]);
      expect(resumed.branches.calls).toEqual([]);
      expect(
        resumed.branches.streams.filter(
          (value) => (value as { kind?: string }).kind === 'replayed',
        ),
      ).toHaveLength(1);
      expect(resumed.branches.streams).toContainEqual({ kind: 'spike-tasks', count: 0 });
      expect(resumed.branches.postTerminationRequests).toBe(0);
      expect(resumed.branches.output).toEqual({
        before: parallelAnswers('single'),
        answers: parallelAnswers('single', 'after'),
      });
      expect(resumed.violations).toEqual([]);
    });
  });
}

/** Build legacy records in place while preserving the IndexedDB envelope and row keys. */
async function storedBindings(
  page: Page,
  strip = false,
  databaseName = 'dspy-state-reload',
): Promise<string[]> {
  return page.evaluate(
    async ({ strip, databaseName }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<string[]>((resolve, reject) => {
          const tx = db.transaction('checkpoints', strip ? 'readwrite' : 'readonly');
          const store = tx.objectStore('checkpoints');
          const request = store.getAll();
          const bindings: string[] = [];
          request.onsuccess = () => {
            for (const row of request.result) {
              const meta = JSON.parse(new TextDecoder().decode(row.metadata.bytes));
              if ('stateBinding' in meta) {
                bindings.push(meta.stateBinding);
                if (strip) {
                  delete meta.stateBinding;
                  row.metadata = {
                    ...row.metadata,
                    bytes: new TextEncoder().encode(JSON.stringify(meta)),
                  };
                  store.put(row);
                }
              }
            }
          };
          tx.oncomplete = () => resolve(bindings);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    { strip, databaseName },
  );
}

/** Compare all stored bytes and effect rows around a refused restore. */
async function bindingStore(page: Page, databaseName = 'dspy-state-reload'): Promise<string> {
  return page.evaluate(async (databaseName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
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
  }, databaseName);
}

if (dspyEngine !== 'chromium')
  for (const scenario of stateBindScenarios.filter((value) => value.lanes.includes('chromium'))) {
    engineTest(`binds paused DSPy state before replay: ${scenario.name}`, async () => {
      if (!booted) throw new Error('The engine boot probe did not pass.');
      const origin = state.origin;
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const external: string[] = [];
      const headers: string[] = [];
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      context.on('response', (response) => recordHeader(response, headers));
      try {
        const page = await context.newPage();
        await page.goto(`${origin}/?case=${scenario.name}&reload`);
        const first = await reloadResult(page);
        expect(first.error).toBeUndefined();
        expect(first.violations).toEqual([]);
        expect(first.reload.error).toBeUndefined();
        expect(first.reload.pending).toBeDefined();
        expect(first.reload.calls).toEqual(['before']);
        expect(first.reload.requests).toBe(
          scenario.program === 'state-durable-early-model' ? 1 : 0,
        );
        expect(await storedBindings(page, scenario.pause === 'legacy')).toEqual([
          expect.stringMatching(/^[0-9a-f]{64}$/),
        ]);
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
          const sources = await stateRestoreSources(
            { ...scenario, outcome: scenario.predicted },
            'resume',
          );
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
        expect(headers.every((value) => value === dspyHeader)).toBe(true);
      } finally {
        await context.close();
      }
    });
  }
