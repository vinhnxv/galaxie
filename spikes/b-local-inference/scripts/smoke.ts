// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import type {} from '../src/main.js';
import type { ResultsV1 } from '../src/results.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'http://127.0.0.1:4173';
const failures: string[] = [];
const examples: Record<string, 'passed' | 'failed' | 'skipped'> = {};
async function step(id: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    examples[id] = 'passed';
    console.log(`${id}: passed`);
  } catch (error) {
    failures.push(id);
    examples[id] = 'failed';
    console.error(`${id}: failed`, error instanceof Error ? error.message : 'unknown_error');
  }
}
let pageErrors = 0;
let externalRequests = 0;
async function blockModels(context: BrowserContext, allowedOrigin: string): Promise<void> {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === allowedOrigin) await route.continue();
    else {
      externalRequests++;
      await route.abort('blockedbyclient');
    }
  });
  await context.addInitScript(() => {
    const scope = globalThis as unknown as {
      LanguageModel?: { create: (...args: unknown[]) => unknown };
      __promptCreates?: number;
    };
    scope.__promptCreates = 0;
    if (scope.LanguageModel)
      scope.LanguageModel.create = () => {
        scope.__promptCreates = (scope.__promptCreates ?? 0) + 1;
        throw new Error('smoke_must_not_create');
      };
  });
  context.on('page', (page) => page.on('pageerror', () => pageErrors++));
}
async function run(page: Page, query: string): Promise<ResultsV1> {
  await page.goto(`${origin}/?${query}`);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.waitForFunction(
    () => window.spikeB.status().done || window.spikeB.status().error,
    null,
    { timeout: 30_000 },
  );
  const status = await page.evaluate(() => window.spikeB.status());
  assert.equal(status.error, null);
  assert.equal(status.done, true);
  return resultsSchema.parse(await page.evaluate(() => window.spikeB.results()));
}
function noText(result: ResultsV1): void {
  const json = JSON.stringify(result);
  const prompts = [
    ...tasks.flatMap((task) => task.messages),
    ...resetRecall,
    ...resetRemember,
    ...schemaProbe.messages,
    ...schemaCoverage.messages,
  ];
  for (const message of prompts)
    assert.equal(json.includes(message.content), false, 'prompt_text_excluded');
  for (const value of [
    codeWord,
    'Yesterday I go to school.',
    'Use the past tense went.',
    'A sentence about the weather.',
  ])
    assert.equal(json.includes(value), false, 'output_text_excluded');
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      assert.equal(
        ['text', 'prompt', 'messages', 'content', 'output'].includes(key),
        false,
        'text_field_excluded',
      );
      visit(item);
    }
  }
  visit(result);
}
const server = await createServer({ configFile: `${root}/vite.config.ts` });
let lanServer: ViteDevServer | undefined;
const { CHECK_NAMES, resultsSchema } = (await server.ssrLoadModule(
  '/src/results.ts',
)) as typeof import('../src/results.js');
const { codeWord, resetRecall, resetRemember, schemaCoverage, schemaProbe, tasks } =
  (await server.ssrLoadModule('/src/tasks.ts')) as typeof import('../src/tasks.js');
await server.listen();
const browser = await chromium.launch({ headless: true });
let baseline: ResultsV1 | undefined;
try {
  const context = await browser.newContext({ acceptDownloads: true });
  await blockModels(context, origin);
  const page = await context.newPage();
  await step('AE1', async () => {
    baseline = await run(page, 'arms=all&runs=5&promptApi=probe&probe=real');
    assert.deepEqual(baseline.armOrder, [
      'mock',
      'ort-own-loop',
      'webllm',
      'transformers-js',
      'prompt-api',
    ]);
    const mock = baseline.arms.find((arm) => arm.id === 'mock');
    assert.ok(mock);
    assert.equal(mock.error, null);
    for (const name of CHECK_NAMES) assert.equal(mock.checks[name].status, 'passed', name);
    assert.deepEqual(
      mock.tasks.map((task) => [task.id, task.runs.length]),
      [
        ['quiz', 5],
        ['feedback-en', 5],
        ['feedback-vi', 5],
      ],
    );
    assert.ok(
      mock.tasks.every((task) => task.status === 'completed' && task.summary.distinctOutputs === 1),
    );
    assert.equal(mock.tasks.find((task) => task.id === 'quiz')?.summary.validRuns, 5);
    for (const arm of baseline.arms.filter((arm) => arm.id !== 'mock')) {
      assert.ok(['available', 'downloadable', 'unavailable'].includes(arm.availability.status));
      if (arm.availability.status === 'unavailable') assert.ok(arm.availability.reason);
      assert.equal(arm.loads.length, 0);
      assert.ok(Object.values(arm.checks).every((check) => check.status === 'not_run'));
    }
    if (baseline.device.webgpu.adapter === null)
      for (const id of ['ort-own-loop', 'webllm', 'transformers-js'])
        assert.deepEqual(baseline.arms.find((arm) => arm.id === id)?.availability, {
          status: 'unavailable',
          reason: 'no_webgpu_adapter',
        });
    assert.equal(typeof baseline.promptApiAvailability.en, 'string');
    assert.equal(typeof baseline.promptApiAvailability.vi, 'string');
    assert.equal(
      await page.evaluate(
        () => (globalThis as unknown as { __promptCreates: number }).__promptCreates,
      ),
      0,
    );
    assert.equal(pageErrors, 0);
    assert.equal(externalRequests, 0);
    noText(baseline);
  });
  await step('AE2', async () => {
    for (const [failure, matching] of [
      ['cancel', 'cancels'],
      ['reset', 'resetPerSession'],
      ['schema', 'schemaEnforcedWhileDecoding'],
    ] as const) {
      const brokenPage = await context.newPage();
      try {
        const result = await run(brokenPage, `arms=mock&runs=5&mockFail=${failure}`);
        const mock = result.arms[0];
        assert.ok(mock);
        for (const name of CHECK_NAMES)
          assert.equal(
            mock.checks[name].status,
            name === matching ? 'failed' : 'passed',
            `${failure}:${name}`,
          );
        noText(result);
        console.log(`  mockFail=${failure}: only ${matching} failed`);
      } finally {
        await brokenPage.close();
      }
    }
  });
  await step('AE3', async () => {
    const cancel = baseline?.arms.find((arm) => arm.id === 'mock')?.cancel;
    assert.ok(cancel);
    assert.equal(cancel.chunksAtAbort, 2);
    assert.equal(cancel.chunksAfterSettle, 0);
    assert.equal(cancel.nextRequestSucceeded, true);
    assert.ok(cancel.abortToSettleMs !== null);
    assert.ok(cancel.nextRequestTtftMs !== null);
    assert.ok(cancel.medianFeedbackTtftMs !== null);
    console.log(
      `  chunksAtAbort=${cancel.chunksAtAbort}, chunksAfterSettle=${cancel.chunksAfterSettle}, nextRequestSucceeded=${cancel.nextRequestSucceeded}`,
    );
  });
  await step('AE4', async () => {
    assert.ok(baseline);
    const expected = await page.evaluate(() => window.spikeB.results());
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download results', exact: true }).click();
    const download = await downloading;
    const path = await download.path();
    assert.ok(path);
    const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(saved, expected);
    noText(resultsSchema.parse(saved));
  });
  const address = Object.values(networkInterfaces())
    .flat()
    .find((info) => info?.family === 'IPv4' && !info.internal)?.address;
  if (!address) {
    examples['AE5'] = 'skipped';
    console.log('AE5: skipped (no non-internal LAN IPv4)');
  } else
    await step('AE5', async () => {
      const previous = process.env['VITE_LAN'];
      process.env['VITE_LAN'] = '1';
      try {
        lanServer = await createServer({ configFile: `${root}/vite.config.ts` });
      } finally {
        if (previous === undefined) delete process.env['VITE_LAN'];
        else process.env['VITE_LAN'] = previous;
      }
      await lanServer.listen();
      const secureOrigin = `https://${address}:4443`;
      const secureContext = await browser.newContext({ ignoreHTTPSErrors: true });
      await blockModels(secureContext, secureOrigin);
      try {
        const securePage = await secureContext.newPage();
        await securePage.goto(secureOrigin);
        assert.deepEqual(
          await securePage.evaluate(() => ({
            protocol: location.protocol,
            secure: isSecureContext,
          })),
          { protocol: 'https:', secure: true },
        );
      } finally {
        await secureContext.close();
      }
    });
  await step('AE6', async () => {
    const source = await readFile(`${root}/README.md`, 'utf8');
    assert.equal(/threshold|pass rate|good enough|fast enough/i.test(source), false);
    assert.equal(pageErrors, 0);
    assert.equal(externalRequests, 0);
  });
  if (baseline) {
    await mkdir(`${root}/results`, { recursive: true });
    await writeFile(
      `${root}/results/smoke.json`,
      `${JSON.stringify(resultsSchema.parse(baseline), null, 2)}\n`,
    );
  }
  await context.close();
} finally {
  await browser.close();
  await lanServer?.close();
  await server.close();
}
console.log(JSON.stringify(examples));
if (failures.length) process.exitCode = 1;
