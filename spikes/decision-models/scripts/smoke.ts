// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Adapted from spikes/b-local-inference/scripts/smoke.ts: local Vite, Chromium,
// blocked/counting external requests, strict exports and results/smoke.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import type {} from '../src/main.js';
import type { Question } from '../src/questions.js';
import type { ArmResult, Results } from '../src/results.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const examples: Record<string, 'passed' | 'failed'> = {};
let externalRequests = 0;
let pageErrors = 0;
let promptCreates = 0;
let baseline: Results | null = null;
async function step(name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    examples[name] = 'passed';
    console.log(`${name}: passed`);
  } catch (error) {
    examples[name] = 'failed';
    console.error(`${name}: failed`, error);
  }
}
const server = await createServer({
  configFile: `${root}/vite.config.ts`,
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
let browser: Browser | undefined;
try {
  const { CHECK_NAMES, resultsSchema } = (await server.ssrLoadModule(
    '/src/results.ts',
  )) as typeof import('../src/results.js');
  const { questions } = (await server.ssrLoadModule(
    '/src/questions.ts',
  )) as typeof import('../src/questions.js');
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === origin) await route.continue();
    else {
      externalRequests++;
      await route.abort('blockedbyclient');
    }
  });
  await context.addInitScript(() => {
    const scope = globalThis as unknown as {
      LanguageModel?: { create(): unknown };
      __promptCreates: number;
    };
    scope.__promptCreates = 0;
    if (scope.LanguageModel)
      scope.LanguageModel.create = () => {
        scope.__promptCreates++;
        throw new Error('smoke_must_not_create');
      };
  });
  context.on('page', (page) =>
    page.on('pageerror', (error) => {
      pageErrors++;
      console.error(error);
    }),
  );
  async function run(page: Page, query: string): Promise<Results> {
    await page.goto(`${origin}/?${query}`);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.waitForFunction(
      () => window.spikeDecision.status().done || window.spikeDecision.status().error,
      null,
      { timeout: 60_000 },
    );
    const status = await page.evaluate(() => window.spikeDecision.status());
    assert.equal(status.error, null);
    assert.equal(status.done, true);
    promptCreates += await page.evaluate(
      () => (globalThis as unknown as { __promptCreates: number }).__promptCreates,
    );
    const result = resultsSchema.parse(await page.evaluate(() => window.spikeDecision.results()));
    noText(result, questions);
    return result;
  }
  function mock(result: Results): ArmResult {
    const arm = result.arms.find((arm) => arm.id === 'mock');
    assert.ok(arm);
    assert.equal(arm.evidence, 'mock-harness');
    return arm;
  }
  function latencyMatrix(result: Results, runs: number): void {
    const arm = mock(result);
    assert.equal(arm.firstDecision.status, 'measured');
    if (arm.firstDecision.status !== 'measured') throw new Error('missing_latency');
    assert.deepEqual(
      arm.firstDecision.value.map((item) => [item.targetStateTokens, item.questionCount]),
      [
        [200, 10],
        [200, 30],
        [1000, 10],
        [1000, 30],
      ],
    );
    for (const item of arm.firstDecision.value) {
      assert.equal(item.runs.length, runs);
      assert.ok(item.warmup);
      const summary = item.summary.endToEndMs;
      assert.equal(summary.p95Reason, runs < 20 ? 'fewer_than_20_runs' : null);
      if (runs < 20) assert.equal(summary.p95, null);
      else assert.equal(typeof summary.p95, 'number');
      for (const trial of [item.warmup, ...item.runs]) {
        assert.equal(trial.evidence, 'mock-harness');
        assert.deepEqual(
          trial.requests.map((request) => request.questionCount),
          item.questionCount === 30 ? [16, 14] : [10],
        );
        assert.equal(trial.repeatedState.processedTimes, item.questionCount === 30 ? 2 : 1);
        assert.equal(
          trial.repeatedState.extraTokens,
          item.questionCount === 30 ? item.targetStateTokens : 0,
        );
        assert.ok(
          trial.aggregate.endToEndMs >=
            trial.requests.reduce((sum, request) => sum + request.endToEndMs, 0),
        );
        assert.equal(
          trial.aggregate.tokenizationMs,
          trial.requests.reduce((sum, request) => sum + request.tokenizationMs, 0),
        );
      }
    }
  }
  const page = await context.newPage();
  await step('Mock measurements and real availability-only paths', async () => {
    baseline = await run(page, 'arms=mock,builtin-ai,watersheep,laya,d1&probe=real');
    latencyMatrix(baseline, 5);
    const arm = mock(baseline);
    assert.equal(arm.status, 'completed');
    for (const name of CHECK_NAMES) assert.equal(arm.functionalChecks[name].status, 'passed', name);
    assert.equal(arm.accuracy.status, 'measured');
    if (arm.accuracy.status === 'measured')
      for (const split of arm.accuracy.value) {
        assert.equal(split.overall.count, 100);
        assert.equal(split.byDomain.length, 4);
        assert.equal(split.byType.length, 3);
        assert.equal(
          split.byDomain.reduce((sum, group) => sum + group.count, 0),
          100,
        );
        assert.ok(split.overall.wilson95.low <= split.overall.fraction);
        assert.ok(split.overall.wilson95.high >= split.overall.fraction);
      }
    assert.equal(arm.ece.status, 'measured');
    if (arm.ece.status === 'measured')
      for (const split of arm.ece.value) {
        assert.equal(split.calibration.status, 'measured');
        if (split.calibration.status === 'measured') {
          assert.ok(split.calibration.value >= 0 && split.calibration.value <= 1);
          assert.equal(split.calibration.binCount, 10);
          assert.equal(
            split.calibration.bins.reduce((sum, bin) => sum + bin.count, 0),
            100,
          );
          assert.ok(split.calibration.bins.every((bin) => bin.belowMinimum === bin.count < 10));
        }
      }
    assert.deepEqual(
      baseline.inventory.map((entry) => [entry.id, entry.revision]),
      [
        ['d1-2b-onnx', '2fd61486312020c30a1e3aa5aa677424672b2b37'],
        ['watersheep-0.1.0', '236de6496b530d37e36a8ac63ff8412e92940f6e'],
        ['laya-english-q4', '70aa37224bb0aa778a5375bbc4dade43b0236fd4'],
        ['builtin-ai', null],
      ],
    );
    for (const real of baseline.arms.filter((arm) => arm.id !== 'mock')) {
      if (real.id !== 'builtin-ai')
        assert.ok(['unavailable', 'inference_not_implemented'].includes(real.status));
      assert.equal(real.download.status, 'not_measured');
      assert.equal(real.loadWarm.status, 'not_measured');
      assert.ok(real.inventory?.files.every((file) => file.status === 'not_run'));
      assert.ok(Object.values(real.functionalChecks).every((check) => check.status === 'not_run'));
    }
    assert.equal(arm.agreement.status, 'not_measured');
    assert.equal(resultsSchema.safeParse({ ...baseline, state: 'unexpected' }).success, false);
  });
  await step('Injected failures affect only their own functional check', async () => {
    for (const [failure, matching] of [
      ['truncate', 'answerTypes'],
      ['no-reject-oversize', 'rejectsOversize'],
    ] as const) {
      const broken = await context.newPage();
      try {
        const result = await run(broken, `arms=mock&mockFail=${failure}`);
        for (const name of CHECK_NAMES)
          assert.equal(
            mock(result).functionalChecks[name].status,
            name === matching ? 'failed' : 'passed',
            `${failure}:${name}`,
          );
      } finally {
        await broken.close();
      }
    }
  });
  await step('No confidence has no ECE number', async () => {
    const fresh = await context.newPage();
    try {
      const result = await run(fresh, 'arms=mock&mockConfidence=none');
      const calibration = mock(result).ece;
      assert.equal(calibration.status, 'measured');
      if (calibration.status === 'measured')
        for (const split of calibration.value) {
          assert.deepEqual(split.calibration, {
            status: 'not_applicable_no_confidence',
            missingConfidence: 100,
            total: 100,
          });
          assert.equal(Object.hasOwn(split.calibration, 'value'), false);
        }
    } finally {
      await fresh.close();
    }
  });
  await step('Twenty measured trials provide nearest-rank p95', async () => {
    const fresh = await context.newPage();
    try {
      latencyMatrix(await run(fresh, 'arms=mock&runs=20'), 20);
    } finally {
      await fresh.close();
    }
  });
  await step('Report, reference import, manual input and downloadable export', async () => {
    assert.ok(baseline);
    const before = await page.evaluate(() => window.spikeDecision.report());
    assert.ok(before.startsWith('> MOCK — harness evidence only; never a model measurement.'));
    assert.ok(before.includes('## UNMEASURED'));
    assert.ok(before.includes('reference_not_run'));
    await page.evaluate((reference) => window.spikeDecision.importReference(reference), {
      candidateId: 'deterministic-mock',
      revision: 'v1',
      answers: questions.map((question) => ({ id: question.id, value: question.label })),
    });
    const withReference = resultsSchema.parse(
      await page.evaluate(() => window.spikeDecision.results()),
    );
    const agreement = mock(withReference).agreement;
    assert.equal(agreement.status, 'measured');
    if (agreement.status === 'measured') {
      assert.equal(agreement.value.count, 200);
      const scored = mock(withReference).accuracy;
      assert.equal(scored.status, 'measured');
      if (scored.status === 'measured')
        assert.equal(
          agreement.value.agreed,
          scored.value.reduce((sum, split) => sum + split.overall.correct, 0),
        );
    }
    await page.locator('#memory-alone').fill('123');
    await page.locator('#memory-chat').fill('456');
    await page.getByRole('button', { name: 'Apply manual readings' }).click();
    const memory = resultsSchema.parse(await page.evaluate(() => window.spikeDecision.results()));
    assert.equal(mock(memory).gpuMemory.modelAlone, 123);
    assert.equal(mock(memory).gpuMemory.withChatModel, 456);
    await page.locator('#memory-unsupported').check();
    await page.getByRole('button', { name: 'Apply manual readings' }).click();
    const expected = resultsSchema.parse(await page.evaluate(() => window.spikeDecision.results()));
    assert.equal(mock(expected).gpuMemory.status, 'unsupported_configuration');
    assert.equal(mock(expected).gpuMemory.withChatModel, null);
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download results', exact: true }).click();
    const path = await (await downloading).path();
    assert.ok(path);
    assert.deepEqual(resultsSchema.parse(JSON.parse(await readFile(path, 'utf8'))), expected);
    noText(expected, questions);
    const reportDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download report', exact: true }).click();
    const reportPath = await (await reportDownload).path();
    assert.ok(reportPath);
    assert.equal(
      await readFile(reportPath, 'utf8'),
      await page.evaluate(() => window.spikeDecision.report()),
    );
  });
  await step('Digest, statistics and strict schema boundaries', async () => {
    const checks = await page.evaluate(async (origin) => {
      const { digest } = (await import(
        `${origin}/src/arms/fetch-verified.ts`
      )) as typeof import('../src/arms/fetch-verified.js');
      const { accuracy, ece, summarize } = (await import(
        `${origin}/src/stats.ts`
      )) as typeof import('../src/stats.js');
      return {
        sha256: await digest(new Uint8Array(new TextEncoder().encode('abc')), 'sha256'),
        gitSha1: await digest(new Uint8Array(new TextEncoder().encode('hello\n')), 'git-blob-sha1'),
        zero: accuracy(0, 10),
        full: accuracy(10, 10),
        p95: summarize(Array.from({ length: 20 }, (_, index) => index + 1)),
        empty: ece([]),
      };
    }, origin);
    assert.equal(checks.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(checks.gitSha1, 'ce013625030ba8dba906f756967f9e9ca394464a');
    assert.ok(checks.zero.wilson95.low >= 0 && checks.full.wilson95.high <= 1);
    assert.equal(checks.p95.p95, 19);
    assert.equal(checks.empty.status, 'not_applicable_no_confidence');
  });
  await step('Committed questions regenerate byte-identically', async () => {
    const before = await readFile(`${root}/data/questions.json`, 'utf8');
    execFileSync(process.execPath, [`${root}/scripts/build-questions.ts`, '--check'], {
      cwd: root,
      stdio: 'pipe',
    });
    execFileSync(process.execPath, [`${root}/scripts/build-questions.ts`], {
      cwd: root,
      stdio: 'pipe',
    });
    assert.equal(await readFile(`${root}/data/questions.json`, 'utf8'), before);
  });
  await step('No external requests, page errors or real session creation', async () => {
    assert.equal(externalRequests, 0);
    assert.equal(pageErrors, 0);
    assert.equal(promptCreates, 0);
  });
  await context.close();
} finally {
  await browser?.close();
  await server.close();
  await mkdir(`${root}/results`, { recursive: true });
  await writeFile(
    `${root}/results/smoke.json`,
    `${JSON.stringify({ evidence: 'mock-harness', examples, externalRequests, pageErrors, promptCreates, baseline }, null, 2)}\n`,
  );
}
if (Object.values(examples).includes('failed')) process.exitCode = 1;

function noText(result: Results, questions: Question[]): void {
  const json = JSON.stringify(result);
  for (const question of questions) {
    assert.equal(json.includes(question.state), false, 'state_text_excluded');
    assert.equal(json.includes(question.prompt), false, 'question_text_excluded');
  }
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      assert.equal(
        ['text', 'prompt', 'state', 'answers', 'label', 'options', 'messages', 'content'].includes(
          key,
        ),
        false,
        'text_field_excluded',
      );
      visit(item);
    }
  }
  visit(result);
}
