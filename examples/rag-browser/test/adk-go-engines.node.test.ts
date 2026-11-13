// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import failures from '../../../tests/conformance/adk-engine-known-failures.json' with {
  type: 'json',
};
import fixtures from '../../../tests/conformance/cases-adk-engine/engine-fixtures.json' with {
  type: 'json',
};
import oracle from '../../../tests/conformance/cases-adk-go/identity-oracle.json' with {
  type: 'json',
};
import scripts from '../../../tests/conformance/cases-adk-go/identity-scripts.json' with {
  type: 'json',
};
import { comparable, type Observed } from './support/adk-go-engine/run.js';
import {
  adkGoEngine,
  buildAdkGoEnginePage,
  launchAdkGoEngine,
  selectAdkGoEngine,
} from './support/adk-go-engine.node.js';
import { buildReference, disposeReference } from './support/adk-go-reference.node.js';
import { maxColdStartMs, maxWasmBytes } from './support/go-gate.node.js';

interface PageState {
  results: Record<string, Observed>;
  durable: Record<string, Observed>;
  errors: Record<string, string>;
  violations: string[];
  done: boolean;
}
type BuiltPage = Awaited<ReturnType<typeof buildAdkGoEnginePage>>;
let browser: Browser;
let positive: BuiltPage;
let negative: BuiltPage;
let measured: Awaited<ReturnType<typeof observe>>;
let wasmBytes: number;
async function observe(
  built: BuiltPage,
): Promise<{ state: PageState; features: Record<string, string> }> {
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
    const page = await context.newPage();
    await page.goto(built.origin);
    await page.waitForFunction(() => Reflect.get(globalThis, 'adkGo')?.done === true, undefined, {
      timeout: 300000,
    });
    const state = (await page.evaluate(() => Reflect.get(globalThis, 'adkGo'))) as PageState;
    const features = await page.evaluate(() => ({
      trustedTypes: typeof Reflect.get(globalThis, 'trustedTypes'),
      WebAssembly: typeof WebAssembly,
      indexedDB: typeof indexedDB,
    }));
    expect(external).toEqual([]);
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((value) => value === built.header)).toBe(true);
    return { state, features };
  } finally {
    await context.close();
  }
}
beforeAll(async () => {
  const reference = await buildReference();
  wasmBytes = reference.wasm.bytes;
  positive = await buildAdkGoEnginePage(reference, scripts, true);
  negative = await buildAdkGoEnginePage(reference, scripts, false);
  browser = await launchAdkGoEngine();
  measured = await observe(positive);
}, 900000);
afterAll(async () => {
  await browser?.close();
  await positive?.close();
  await negative?.close();
  await disposeReference();
}, 900000);
function engineTest(description: string, run: () => Promise<void>): void {
  const title = `${adkGoEngine} ${description}`;
  const registered: readonly string[] = failures[adkGoEngine];
  (registered.includes(title) ? test.fails : test)(title, run, 900000);
}
const names = Object.keys(scripts) as Array<keyof typeof scripts>;
const titles = [
  ...names.map((name) => `measures ${name} live`),
  'measures identity-pause-nested-last durable',
  'refuses wasm compilation without wasm-unsafe-eval',
];
test('registered Go measurement titles are unique and complete', () => {
  expect(new Set(titles).size).toBe(titles.length);
  expect(titles).toEqual(fixtures.lanes.go);
  expect(names.sort()).toEqual(Object.keys(oracle).sort());
}, 900000);
test('Go engine selection refuses unknown names with the configuration error', () => {
  expect(selectAdkGoEngine()).toBe('chromium');
  expect(() => selectAdkGoEngine('unknown')).toThrow(
    'GALAXIE_BROWSER must be one of chromium, firefox, webkit, not "unknown".',
  );
}, 900000);
test('Go preview preserves strict CSP on revalidation', async () => {
  const initial = await fetch(positive.origin);
  expect(initial.status).toBe(200);
  expect(initial.headers.get('content-security-policy')).toBe(positive.header);
  const etag = initial.headers.get('etag');
  expect(etag, 'The preview must supply an ETag for conditional revalidation.').toBeTruthy();
  await initial.arrayBuffer();
  const revalidated = await fetch(positive.origin, { headers: { 'If-None-Match': etag ?? '' } });
  expect(revalidated.status).toBe(304);
  expect(revalidated.headers.get('content-security-policy')).toBe(positive.header);
}, 900000);
engineTest('boots ADK Go under strict CSP within the existing limits', async () => {
  expect(positive.header).toContain("'wasm-unsafe-eval'");
  expect(measured.features['WebAssembly']).toBe('object');
  expect(measured.features['indexedDB']).toBe('object');
  const coldStarts = Object.values(measured.state.results).map((r) => r.coldStartMs);
  expect(coldStarts).toHaveLength(names.length);
  for (const ms of coldStarts) {
    expect(ms).toBeDefined();
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThanOrEqual(maxColdStartMs);
  }
  expect(wasmBytes).toBeLessThanOrEqual(maxWasmBytes);
  process.stdout.write(
    `${JSON.stringify({ engine: adkGoEngine, version: browser.version(), features: measured.features, wasmBytes, coldStartMs: Math.max(...coldStarts.map((ms) => ms ?? -1)) })}\n`,
  );
});
function checkIdentity(
  name: keyof typeof scripts,
  observed: Observed | undefined,
): asserts observed is Observed {
  expect(measured.state.violations).toEqual([]);
  expect(observed).toBeDefined();
  if (!observed) throw new Error('The identity result is missing.');
  expect(observed.error).toBeNull();
  expect(observed.requests).toHaveLength(scripts[name].replies.length);
  const authors = observed.streams
    .filter((event) => event.mode === 'messages')
    .map((event) => (event.data as { author: string }).author);
  expect(authors.length).toBeGreaterThan(0);
  const unordered = 'unordered' in scripts[name] && scripts[name].unordered;
  expect(unordered ? [...authors].sort() : authors).toEqual(
    unordered ? [...oracle[name].textAuthors].sort() : oracle[name].textAuthors,
  );
  expect(observed.streams.length).toBeGreaterThan(0);
  for (const event of observed.streams) expect(event.path).toEqual([]);
}
for (const name of names) {
  engineTest(`measures ${name} live`, async () => {
    expect(measured.state.errors[name]).toBeUndefined();
    const observed = measured.state.results[name];
    checkIdentity(name, observed);
    expect(observed.lifetimes).toBe(1);
    expect(observed.workerStarts).toBe(1);
    if (name === 'identity-pause-nested-last') checkPause(observed);
    else expect(observed.pauses).toEqual([]);
  });
}
function checkPause(observed: Observed): void {
  const expected = oracle['identity-pause-nested-last'].expectedPause;
  expect(observed.pauses).toEqual(expected.pauses);
  expect(observed.capabilities).toEqual(expected.capabilities);
  expect(observed.output).toBe(expected.output);
  expect(observed.error).toEqual(expected.error);
}
engineTest('measures identity-pause-nested-last durable', async () => {
  const name = 'identity-pause-nested-last';
  expect(measured.state.errors[`durable:${name}`]).toBeUndefined();
  expect(measured.state.errors[`cleanup:${name}`]).toBeUndefined();
  const observed = measured.state.durable[name];
  checkIdentity(name, observed);
  checkPause(observed);
  expect(observed.lifetimes).toBe(2);
  expect(observed.workerStarts).toBe(2);
  const live = measured.state.results[name];
  if (!live) throw new Error('The live pause result is missing.');
  expect(comparable(observed)).toEqual(comparable(live));
  expect(observed.streams).toEqual(live.streams);
});
engineTest('refuses wasm compilation without wasm-unsafe-eval', async () => {
  expect(negative.header).not.toContain('wasm-unsafe-eval');
  const { state } = await observe(negative);
  const results = Object.values(state.results);
  expect(results.length + Object.keys(state.errors).length).toBeGreaterThan(0);
  for (const result of results) expect(result.output).toBe('');
  expect(Object.keys(state.errors).length + results.filter((r) => r.error).length).toBeGreaterThan(
    0,
  );
});
