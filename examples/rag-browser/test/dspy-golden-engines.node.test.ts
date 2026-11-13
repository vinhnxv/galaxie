// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import failures from '../../../tests/conformance/dspy-engine-known-failures.json' with {
  type: 'json',
};
import type { DspyTranscript } from '../../../tests/conformance/support/dspy.js';
import {
  dspyGoldenCases,
  dspyGoldenFamily,
  dspyGoldenSpecs,
  type GoldenResult,
} from '../../../tests/conformance/support/dspy-golden.js';
import { dspyGoldenSources } from '../../../tests/conformance/support/dspy-golden-sources.node.js';
import { dspySources } from '../../../tests/conformance/support/dspy-sources.node.js';
import {
  buildDspyPage,
  dspyEngine,
  dspyHeader,
  launchDspyEngine,
  selectDspyEngine,
} from './support/dspy-engine.node.js';

let browser: Browser;
let built: Awaited<ReturnType<typeof buildDspyPage>>;
let booted = false;
const timeout = 900000;
interface PageResult {
  readonly error?: string;
  readonly errorCode?: string;
  readonly violations: string[];
  readonly workerErrors: string[];
  readonly traffic: { kind: string; op: string; replayed: boolean }[];
  readonly transcript: DspyTranscript;
  readonly golden: GoldenResult;
}
beforeAll(async () => {
  selectDspyEngine(process.env['GALAXIE_BROWSER']);
  const cases: Record<string, Record<string, string>> = { predict: await dspySources('predict') };
  for (const name of dspyGoldenCases) cases[name] = await dspyGoldenSources(name);
  built = await buildDspyPage(new URL('./support/dspy-golden/', import.meta.url), cases);
  browser = await launchDspyEngine();
  console.info(JSON.stringify({ engine: dspyEngine, version: browser.version() }));
}, timeout);
afterAll(async () => {
  await browser?.close();
  await built?.close();
}, timeout);

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
    timeout,
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
  context.on('response', (response) =>
    headers.push(response.headers()['content-security-policy'] ?? ''),
  );
  try {
    await run(await context.newPage());
  } finally {
    try {
      expect(external).toEqual([]);
      expect(headers.length).toBeGreaterThan(0);
      expect(headers.every((header) => header === dspyHeader)).toBe(true);
    } finally {
      await context.close();
    }
  }
}
async function result(page: Page): Promise<PageResult> {
  await page.waitForFunction(
    () => Reflect.get(globalThis, 'dspyGoldenConformance')?.done,
    undefined,
    { timeout },
  );
  const value = (await page.evaluate(() =>
    Reflect.get(globalThis, 'dspyGoldenConformance'),
  )) as PageResult;
  if (value.golden)
    console.info(
      JSON.stringify({
        engine: dspyEngine,
        name: new URL(page.url()).searchParams.get('case'),
        violations: value.violations,
        sideEvidence: value.golden.sideEvidence,
        requests: value.golden.transcript.requests.length,
        capabilities: value.golden.transcript.capabilities.length,
        output: value.golden.transcript.output,
        error: value.golden.transcript.error,
      }),
    );
  expect(value.error).toBeUndefined();
  expect(value.violations).toEqual([]);
  expect(value.workerErrors).toEqual([]);
  return value;
}
async function golden(name: string): Promise<DspyTranscript> {
  const directory = name === 'predict' ? 'golden-dspy' : `golden-dspy-${dspyGoldenFamily(name)}`;
  const file = name === 'predict' ? 'predict.json' : dspyGoldenSpecs[name]?.golden;
  return JSON.parse(
    await readFile(
      new URL(`../../../tests/conformance/${directory}/${file}`, import.meta.url),
      'utf8',
    ),
  ) as DspyTranscript;
}

engineTest(
  'boots the runtime and retrieval golden page under strict CSP',
  async () => {
    await withPage(async (page) => {
      await page.goto(`${built.origin}/?case=predict`);
      expect((await result(page)).transcript).toEqual(await golden('predict'));
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

for (const name of dspyGoldenCases)
  engineTest(`matches the new DSPy golden: ${name}`, async () => {
    await withPage(async (page) => {
      await page.goto(`${built.origin}/?case=${name}`);
      const measured = await result(page);
      expect(measured.golden.transcript).toEqual(await golden(name));
      for (const evidence of measured.golden.sideEvidence) {
        if (evidence['kind'] === 'spike-tasks') expect(evidence['count']).toBe(0);
        else {
          expect(evidence['recorder']).toBe(true);
          expect(evidence['unexpected']).toBe(false);
          const attempts = evidence['attempts'] as string[];
          expect(attempts.every((target) => target === '127.0.0.1:9')).toBe(true);
          if (name === 'pe-retrieve-colbert') expect([0, 1]).toContain(attempts.length);
          else expect(attempts).toEqual([]);
          console.info(JSON.stringify({ engine: dspyEngine, name, ...evidence }));
        }
      }
      if (name.startsWith('pe-'))
        expect(measured.golden.sideEvidence.map((value) => value['kind']).sort()).toEqual([
          'provider-egress',
          'spike-tasks',
        ]);
    });
  });

engineTest('replays runtime LabeledFewShot after an IndexedDB page reload', async () => {
  await withPage(async (page) => {
    const name = 'rt-opt-labeled-two-stage';
    await page.goto(`${built.origin}/?case=${name}&reload`);
    const first = await result(page);
    expect(first.golden.pending).toBeDefined();
    expect(first.golden.transcript.error).toBeNull();
    expect(first.golden.transcript.requests).toHaveLength(1);
    await page.evaluate(
      (sessionId) => sessionStorage.setItem('dspyGoldenStep', JSON.stringify({ sessionId })),
      first.golden.sessionId,
    );
    await page.reload();
    const second = await result(page);
    const expected = await golden(name);
    expect(second.golden.restored).toEqual(first.golden.pending);
    expect(second.golden.pending).toBeUndefined();
    expect(second.golden.transcript.error).toBeNull();
    expect(second.golden.transcript.requests).toEqual(expected.requests.slice(1));
    expect([...first.golden.transcript.requests, ...second.golden.transcript.requests]).toEqual(
      expected.requests,
    );
    expect([...first.golden.transcript.responses, ...second.golden.transcript.responses]).toEqual(
      expected.responses,
    );
    expect([
      ...first.golden.transcript.interactions,
      ...second.golden.transcript.interactions,
    ]).toEqual(expected.interactions);
    expect([
      ...(first.golden.transcript.events ?? []),
      ...(second.golden.transcript.events ?? []),
    ]).toEqual(expected.events);
    expect(second.golden.transcript.output).toEqual(expected.output);
    expect(second.traffic.filter((frame) => frame.replayed)).toHaveLength(1);
    const frontier = second.traffic.findIndex((frame) => frame.replayed);
    expect(frontier).toBeGreaterThanOrEqual(0);
    expect(second.traffic.slice(0, frontier)).toEqual([]);
    expect(second.traffic.slice(frontier + 1)).toEqual([
      { kind: 'request', op: 'model', replayed: false },
    ]);
  });
});
