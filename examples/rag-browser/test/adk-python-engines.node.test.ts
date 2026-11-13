// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import failures from '../../../tests/conformance/adk-engine-known-failures.json' with {
  type: 'json',
};
import fixtures from '../../../tests/conformance/cases-adk-engine/engine-fixtures.json' with {
  type: 'json',
};
import {
  type AdkReloadResult,
  joinAdkReload,
} from '../../../tests/conformance/support/adk-python-restore.js';
import {
  adkEngine,
  adkHeader,
  buildAdkPythonPage,
  launchAdkEngine,
  selectAdkEngine,
} from './support/adk-engine.node.js';

const names = ['before', 'after', 'between'].flatMap((position) =>
  ['approve', 'deny'].map((answer) => `confirm-beside-${position}-${answer}`),
);
const titles = names.flatMap((name) =>
  ['live', 'reload'].map((mode) => `measures ${name} ${mode}`),
);
let browser: Browser;
let built: Awaited<ReturnType<typeof buildAdkPythonPage>>;
beforeAll(async () => {
  built = await buildAdkPythonPage(names);
  browser = await launchAdkEngine();
}, 900000);
afterAll(async () => {
  await browser?.close();
  await built?.close();
}, 900000);

function engineTest(description: string, run: () => Promise<void>): void {
  const title = `${adkEngine} ${description}`;
  const registered: readonly string[] = failures[adkEngine];
  (registered.includes(title) ? test.fails : test)(title, run, 900000);
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
  context.on('response', (response) =>
    headers.push(response.headers()['content-security-policy'] ?? ''),
  );
  try {
    await run(await context.newPage());
    expect(external).toEqual([]);
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((value) => value === adkHeader)).toBe(true);
  } finally {
    await context.close();
  }
}
async function result(page: Page): Promise<{
  error?: string;
  violations: string[];
  transcript?: unknown;
  reload?: AdkReloadResult;
}> {
  await page.waitForFunction(
    () => Reflect.get(globalThis, 'adkPythonConformance')?.done,
    undefined,
    { timeout: 300000 },
  );
  const value = await page.evaluate(() => Reflect.get(globalThis, 'adkPythonConformance'));
  expect(value.error).toBeUndefined();
  expect(value.violations).toEqual([]);
  return value;
}
async function golden(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL(`../../../tests/conformance/golden-adk-python/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
}

test('registered Python measurement titles are unique and complete', () => {
  expect(new Set(titles).size).toBe(titles.length);
  expect(titles).toEqual(fixtures.lanes.python);
  for (const engine of fixtures.engines) {
    for (const title of failures[engine as keyof typeof failures]) {
      expect(
        [...fixtures.lanes.python, ...fixtures.lanes.go].some(
          (name) => title === `${engine} ${name}`,
        ),
      ).toBe(true);
    }
  }
}, 900000);
test('engine selection refuses unknown names with the configuration error', () => {
  expect(selectAdkEngine()).toBe('chromium');
  expect(() => selectAdkEngine('unknown')).toThrow(
    'GALAXIE_BROWSER must be one of chromium, firefox, webkit, not "unknown".',
  );
}, 900000);
test('answers revalidation with the strict CSP header', async () => {
  const url = `${built.origin}/conformance/${names[0]}/selected.py`;
  const initial = await fetch(url);
  expect(initial.status).toBe(200);
  expect(initial.headers.get('content-security-policy')).toBe(adkHeader);
  const etag = initial.headers.get('etag');
  expect(etag, 'The preview must supply an ETag for conditional revalidation.').toBeTruthy();
  await initial.arrayBuffer();
  const revalidated = await fetch(url, { headers: { 'If-None-Match': etag ?? '' } });
  expect(revalidated.status).toBe(304);
  expect(revalidated.headers.get('content-security-policy')).toBe(adkHeader);
}, 900000);

engineTest('boots ADK Python under strict CSP', async () => {
  await withPage(async (page) => {
    console.info(JSON.stringify({ engine: adkEngine, version: browser.version() }));
    await page.goto(`${built.origin}/?case=${names[0]}`);
    const features = await page.evaluate(() => ({
      trustedTypes: typeof Reflect.get(globalThis, 'trustedTypes'),
      WebAssembly: typeof WebAssembly,
      indexedDB: typeof indexedDB,
    }));
    console.info(JSON.stringify({ engine: adkEngine, features }));
    expect(features.WebAssembly).toBe('object');
    expect(features.indexedDB).toBe('object');
    expect((await result(page)).transcript).toEqual(await golden(names[0] ?? ''));
  });
});
for (const name of names) {
  engineTest(`measures ${name} live`, async () => {
    await withPage(async (page) => {
      await page.goto(`${built.origin}/?case=${name}`);
      expect((await result(page)).transcript).toEqual(await golden(name));
    });
  });
  engineTest(`measures ${name} reload`, async () => {
    await withPage(async (page) => {
      await page.goto(`${built.origin}/?case=${name}&reload=1`);
      const first = (await result(page)).reload;
      if (!first) throw new Error('The reload fixture produced no result.');
      expect(first.pending).toBeDefined();
      const steps = [first];
      let current = first;
      let reloads = 0;
      for (; current.pending && reloads < 3; reloads++) {
        const before = current.pending;
        await page.evaluate(
          (step) => sessionStorage.setItem('adkReloadStep', JSON.stringify(step)),
          { name, sessionId: current.sessionId, answerIndex: reloads },
        );
        await page.reload();
        const next = (await result(page)).reload;
        if (!next) throw new Error('The reload fixture produced no result.');
        expect(next.restored).toEqual(before);
        steps.push(next);
        current = next;
      }
      expect(reloads).toBeGreaterThan(0);
      expect(current.pending).toBeUndefined();
      expect(joinAdkReload(steps, name)).toEqual(await golden(name));
      expect(current.consumed).toBe(true);
    });
  });
}
