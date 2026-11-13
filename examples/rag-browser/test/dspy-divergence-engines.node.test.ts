// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import failures from '../../../tests/conformance/dspy-engine-known-failures.json' with {
  type: 'json',
};
import type { executePoisonRetry } from '../../../tests/conformance/support/dspy-poison-retry.js';
import { poisonSources } from '../../../tests/conformance/support/dspy-poison-sources.node.js';
import type { DspyReloadResult } from '../../../tests/conformance/support/dspy-restore.js';
import {
  buildDspyPage,
  dspyEngine,
  dspyHeader,
  launchDspyEngine,
} from './support/dspy-engine.node.js';

type Measured = {
  error?: string;
  errorCode?: string;
  violations: string[];
  workerErrors: string[];
  commands: string[];
  reload?: DspyReloadResult;
  retry?: Awaited<ReturnType<typeof executePoisonRetry>>;
  bindTraffic: { models: number; capabilities: number; replayed: number };
};
type Envelope = { type: string; bytes: number[] };
type Checkpoint = {
  key: string[];
  parentId: string | null;
  checkpoint: Envelope;
  metadata: Envelope;
};
type Write = { key: (string | number)[]; channel: string; value: Envelope };
type Stored = [Checkpoint[], Write[], unknown[]];
let browser: Browser;
let built: Awaited<ReturnType<typeof buildDspyPage>>;
let booted = false;

beforeAll(async () => {
  const cases: Record<string, Record<string, string>> = {};
  for (const program of ['original', 'changed', 'removed', 'same-instance'] as const)
    cases[`poison-${program}`] = await poisonSources(program);
  built = await buildDspyPage(new URL('./support/dspy-divergence/', import.meta.url), cases);
  browser = await launchDspyEngine();
  console.info(JSON.stringify({ engine: dspyEngine, version: browser.version() }));
}, 900000);

afterAll(async () => {
  await browser?.close();
  await built?.close();
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

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const external: string[] = [],
    headers: string[] = [];
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === built.origin) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  context.on('response', (response) => {
    const header = response.headers()['content-security-policy'] ?? '';
    headers.push(header);
    if (header !== dspyHeader)
      console.info(
        JSON.stringify({
          engine: dspyEngine,
          cspMismatch: {
            url: response.url(),
            status: response.status(),
            header,
          },
        }),
      );
  });
  try {
    await run(await context.newPage());
    expect(external).toEqual([]);
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((header) => header === dspyHeader)).toBe(true);
  } finally {
    await context.close();
  }
}

async function result(page: Page): Promise<Measured> {
  await page.waitForFunction(
    () => Reflect.get(globalThis, 'dspyDivergenceConformance')?.done,
    undefined,
    { timeout: 900000 },
  );
  const measured: Measured = await page.evaluate(() =>
    Reflect.get(globalThis, 'dspyDivergenceConformance'),
  );
  expect(measured.violations).toEqual([]);
  expect(measured.workerErrors).toEqual([]);
  return measured;
}

async function next(
  page: Page,
  variant: string,
  program: string,
  sessionId: string,
  start = false,
): Promise<Measured> {
  await page.evaluate(
    (step) => sessionStorage.setItem('dspyDivergenceStep', JSON.stringify(step)),
    { name: `poison-${program}`, program, variant, sessionId, start },
  );
  await page.reload();
  return result(page);
}

/** Include every byte of checkpoints, pending writes and capability effects. */
async function stored(page: Page, variant: string): Promise<string> {
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
  }, `dspy-divergence-${variant}`);
}

function decode(envelope: Envelope): unknown {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(envelope.bytes)));
}

function assertMarker(before: Stored, after: Stored): void {
  expect(after[0]).toHaveLength(before[0].length + 1);
  expect(after[1]).toHaveLength(before[1].length + 1);
  expect(after[2]).toEqual(before[2]);
  const previous = new Set(before[0].map((row) => JSON.stringify(row.key)));
  expect(after[0].filter((row) => previous.has(JSON.stringify(row.key)))).toEqual(before[0]);
  const oldWrites = new Set(before[1].map((row) => JSON.stringify(row.key)));
  expect(after[1].filter((row) => oldWrites.has(JSON.stringify(row.key)))).toEqual(before[1]);
  const added = after[0].filter((row) => !previous.has(JSON.stringify(row.key)));
  expect(added).toHaveLength(1);
  const marker = added[0];
  if (!marker) throw new Error('The poison checkpoint is missing.');
  const latest = before[0]
    .map((row) => row.key[4])
    .sort()
    .at(-1);
  expect(marker.parentId).toBe(latest);
  expect(marker.key[4]).toBe((BigInt(latest ?? '0') + 1n).toString().padStart(20, '0'));
  expect(decode(marker.checkpoint)).toMatchObject({
    status: 'unrecoverable',
    input: null,
    journal: [],
  });
  expect(Object.keys(decode(marker.metadata) as object).sort()).toEqual([
    'adapter',
    'dspy',
    'session',
    'v',
  ]);
  const writes = after[1].filter((row) => !oldWrites.has(JSON.stringify(row.key)));
  expect(writes).toHaveLength(1);
  expect(writes[0]?.key.slice(0, 5)).toEqual(marker.key);
  expect(writes[0]?.key[6]).toBe(-3);
  expect(writes[0]?.channel).toBe('__interrupt__');
  expect(writes[0]?.value.type).toBe('json');
  expect(writes[0] && decode(writes[0].value)).toBeNull();
}

engineTest(
  'boots DSPy divergence probes under strict CSP',
  async () => {
    await withPage(async (page) => {
      await page.goto(`${built.origin}/?variant=changed`);
      const measured = await result(page);
      expect(measured.error).toBeUndefined();
      expect(measured.reload?.error).toBeUndefined();
      expect(measured.reload?.pending).toBeDefined();
      expect(measured.reload?.calls).toEqual(['before']);
      expect(measured.reload?.requests).toBe(0);
    });
    booted = true;
  },
  false,
);

for (const variant of ['changed', 'removed'] as const)
  engineTest(`measures divergence poison persistence: ${variant}`, async () => {
    await withPage(async (page) => {
      await page.goto(`${built.origin}/?variant=${variant}`);
      const first = await result(page);
      expect(first.error).toBeUndefined();
      expect(first.reload?.error).toBeUndefined();
      expect(first.reload?.pending).toBeDefined();
      expect(first.reload?.calls).toEqual(['before']);
      expect(first.reload?.requests).toBe(0);
      const sessionId = first.reload?.sessionId;
      if (!sessionId) throw new Error('The paused session is missing.');
      const paused = await stored(page, variant);
      const diverged = await next(page, variant, variant, sessionId);
      expect(diverged.error).toBeUndefined();
      expect(diverged.reload?.error).toEqual({
        code: 'unrecoverable',
        message: 'Stored state cannot be recovered.',
      });
      expect(diverged.reload?.calls).toEqual([]);
      expect(diverged.reload?.requests).toBe(0);
      expect(diverged.bindTraffic).toEqual({ models: 0, capabilities: 0, replayed: 0 });
      const poisoned = await stored(page, variant);
      assertMarker(JSON.parse(paused) as Stored, JSON.parse(poisoned) as Stored);
      const original = await next(page, variant, 'original', sessionId);
      expect(original.errorCode).toBe('unrecoverable');
      expect(original.error).toBe('Stored state cannot be recovered.');
      expect(original.bindTraffic).toEqual({ models: 0, capabilities: 0, replayed: 0 });
      expect(original.commands).not.toContain('run');
      expect(await stored(page, variant)).toBe(poisoned);
      for (let attempt = 0; attempt < 2; attempt++) {
        const adopted = await next(page, variant, 'original', sessionId, true);
        expect(adopted.errorCode).toBe('invalid');
        expect(adopted.error).toBe('An adopted session can only be restored.');
        expect(adopted.bindTraffic).toEqual({ models: 0, capabilities: 0, replayed: 0 });
        // Preparation boots the Worker; the adopted start sends neither pending nor run.
        expect(adopted.commands).toEqual(['boot']);
        expect(await stored(page, variant)).toBe(poisoned);
      }
      console.info(
        JSON.stringify({
          engine: dspyEngine,
          variant,
          firstMarker: 'PASS',
          repeatedExecute: 'UNREACHABLE',
        }),
      );
    });
  });

engineTest('bounds same-instance public start after poison', async () => {
  await withPage(async (page) => {
    await page.goto(`${built.origin}/?variant=same-instance`);
    const measured = await result(page);
    expect(measured.error).toBeUndefined();
    expect(measured.retry?.errors).toEqual(
      Array.from({ length: 3 }, () => ({
        code: 'unrecoverable',
        message: 'Stored state cannot be recovered.',
      })),
    );
    expect(measured.retry?.calls).toEqual(['before']);
    expect(measured.retry?.requests).toBe(0);
    expect(measured.bindTraffic).toEqual({ models: 0, capabilities: 1, replayed: 0 });
    expect(measured.retry?.snapshots).toHaveLength(3);
    const first = measured.retry?.snapshots[0];
    if (first === undefined) throw new Error('The first poison snapshot is missing.');
    const saved = JSON.parse(first) as Stored;
    expect(saved[0]).toHaveLength(2);
    expect(saved[1]).toHaveLength(2);
    const marker = saved[0][1];
    if (!marker) throw new Error('The first poison checkpoint is missing.');
    expect(marker.parentId).toBe(saved[0][0]?.key[4]);
    expect(decode(marker.checkpoint)).toMatchObject({
      status: 'unrecoverable',
      input: null,
      journal: [],
    });
    expect(Object.keys(decode(marker.metadata) as object).sort()).toEqual([
      'adapter',
      'dspy',
      'session',
      'v',
    ]);
    const writes = saved[1].filter(
      (row) => JSON.stringify(row.key.slice(0, 5)) === JSON.stringify(marker.key),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key[6]).toBe(-3);
    expect(writes[0]?.channel).toBe('__interrupt__');
    expect(writes[0]?.value.type).toBe('json');
    expect(writes[0] && decode(writes[0].value)).toBeNull();
    expect(measured.retry?.snapshots).toEqual([first, first, first]);
    expect(await stored(page, 'same-instance')).toBe(first);
    console.info(
      JSON.stringify({ engine: dspyEngine, sameInstancePublicStart: 'PASS', markerRows: 1 }),
    );
  });
});
