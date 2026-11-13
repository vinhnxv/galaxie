// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import failures from '../../../tests/conformance/dspy-engine-known-failures.json' with {
  type: 'json',
};
import {
  dspySchemaCases,
  dspySchemaSpecs,
  type SchemaResult,
} from '../../../tests/conformance/support/dspy-schema.js';
import { dspySchemaSources } from '../../../tests/conformance/support/dspy-schema-sources.node.js';
import {
  buildDspyPage,
  dspyEngine,
  dspyHeader,
  launchDspyEngine,
  selectDspyEngine,
} from './support/dspy-engine.node.js';

let browser: Browser;
let built: Awaited<ReturnType<typeof buildDspyPage>>;
const timeout = 900000;
interface PageResult {
  readonly error?: string;
  readonly violations: string[];
  readonly workerErrors: string[];
  readonly schema: SchemaResult;
}
beforeAll(async () => {
  selectDspyEngine(process.env['GALAXIE_BROWSER']);
  const cases: Record<string, Record<string, string>> = {};
  for (const name of dspySchemaCases) cases[name] = await dspySchemaSources(name);
  built = await buildDspyPage(new URL('./support/dspy-schema/', import.meta.url), cases);
  browser = await launchDspyEngine();
  console.info(JSON.stringify({ engine: dspyEngine, version: browser.version() }));
}, timeout);
afterAll(async () => {
  await browser?.close();
  await built?.close();
}, timeout);

function engineTest(description: string, run: () => Promise<void>): void {
  const title = `${dspyEngine} ${description}`;
  const registered: readonly string[] = failures[dspyEngine];
  const register = registered.includes(title) ? test.fails : test;
  register(title, run, timeout);
}
async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const external: string[] = [];
  const headers: string[] = [];
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
    () => Reflect.get(globalThis, 'dspySchemaConformance')?.done,
    undefined,
    { timeout },
  );
  const value = (await page.evaluate(() =>
    Reflect.get(globalThis, 'dspySchemaConformance'),
  )) as PageResult;
  if (value.schema)
    console.info(
      JSON.stringify({
        engine: dspyEngine,
        name: new URL(page.url()).searchParams.get('case'),
        noFeature: new URL(page.url()).searchParams.has('no-feature'),
        requests: value.schema.transcript.requests.length,
        capabilities: value.schema.transcript.capabilities.length,
        output: value.schema.transcript.output,
        error: value.schema.transcript.error,
        violations: value.violations,
      }),
    );
  expect(value.error).toBeUndefined();
  expect(value.violations).toEqual([]);
  expect(value.workerErrors).toEqual([]);
  return value;
}

for (const name of dspySchemaCases)
  engineTest(`matches the DSPy schema golden: ${name}`, async () => {
    await withPage(async (page) => {
      await page.goto(`${built.origin}/?case=${name}`);
      expect((await result(page)).schema.transcript).toEqual(
        JSON.parse(
          await readFile(
            new URL(
              `../../../tests/conformance/golden-dspy-schema/${dspySchemaSpecs[name]?.golden}`,
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      );
    });
  });

engineTest('refuses a schema route without structured-output before the provider', async () => {
  await withPage(async (page) => {
    await page.goto(`${built.origin}/?case=so-json-adapter-schema&no-feature`);
    const transcript = (await result(page)).schema.transcript;
    expect(transcript.error).toEqual({
      code: 'unavailable',
      message: 'The requested service is unavailable.',
    });
    expect(transcript.requests).toEqual([]);
    expect(transcript.capabilities).toEqual([]);
  });
});
