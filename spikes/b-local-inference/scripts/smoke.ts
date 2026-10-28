// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import type { Arm, ModelInfo, Session } from '../src/arms/types.js';
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
  await step('Harness regressions', async () => {
    const fixturePage = await context.newPage();
    try {
      await fixturePage.goto(`${origin}/?arms=mock`);
      const observations = await fixturePage.evaluate(
        async ({ moduleUrl, code }) => {
          const { runArm } = (await import(moduleUrl)) as typeof import('../src/harness.js');
          const fixture: Arm = {
            id: 'mock',
            model: { id: 'post-result-fixture', revision: 'v1' },
            engineVersion: 'fixture',
            inWorker: true,
            decoding: 'greedy',
            schemaMechanism: 'fixture',
            sameCheckpointAs: null,
            probe: async () => ({ status: 'available' }),
            load: async () => ({ loadKind: 'warm', reportedBytes: 0 }),
            dispose: async () => {},
            openSession: async (): Promise<Session> => {
              let late = (): void => {};
              return {
                generate: async (request) => {
                  late = () => {
                    request.onChunk('late');
                    request.onChunk('late');
                  };
                  return {
                    text: request.schema ? JSON.stringify({ code, extra: true }) : 'fixture',
                    constrained: Boolean(request.schema),
                    executedIn: 'DedicatedWorkerGlobalScope',
                    aborted: false,
                  };
                },
                close: async () => late(),
              };
            },
          };
          const result = await runArm(fixture, {
            runs: 1,
            probeReal: false,
            promptProbe: true,
            promptVi: 'unavailable',
            progress: () => {},
          });
          return {
            stream: result.checks.streams.status,
            singleton: result.checks.schemaEnforcedWhileDecoding.status,
          };
        },
        { moduleUrl: `${origin}/src/harness.ts`, code: codeWord },
      );
      assert.deepEqual(observations, { stream: 'failed', singleton: 'failed' });
    } finally {
      await fixturePage.close();
    }
  });
  await step('Checkpoint regressions', async () => {
    const fixturePage = await context.newPage();
    try {
      await fixturePage.goto(`${origin}/?arms=mock`);
      const observations = await fixturePage.evaluate(async (moduleUrl) => {
        const { TransformersArm } = (await import(
          moduleUrl
        )) as typeof import('../src/arms/transformers.js');
        const NativeWorker = globalThis.Worker;
        const primary: ModelInfo = {
          id: 'onnx-community/Qwen2.5-1.5B-Instruct',
          revision: 'fixture-primary',
        };
        const fallback: ModelInfo = {
          id: 'onnx-community/Qwen2.5-0.5B-Instruct',
          revision: 'fixture-fallback',
        };
        const outcomes: boolean[] = [];
        try {
          for (const mode of ['retain-fallback', 'reject-switch']) {
            let loads = 0;
            class LoadWorker {
              onmessage: ((event: MessageEvent) => void) | null = null;
              onerror: ((event: ErrorEvent) => void) | null = null;
              readonly selected: ModelInfo | null;
              constructor(_url: unknown, options?: WorkerOptions) {
                this.selected = options?.name ? (JSON.parse(options.name) as ModelInfo) : null;
              }
              postMessage(command: { id: number; op: string }): void {
                if (command.op === 'load') {
                  loads++;
                  if (this.selected && mode === 'reject-switch') {
                    queueMicrotask(() =>
                      this.onmessage?.(
                        new MessageEvent('message', { data: { id: command.id, kind: 'error' } }),
                      ),
                    );
                    return;
                  }
                  const selected =
                    this.selected ??
                    (mode === 'retain-fallback'
                      ? loads === 1
                        ? fallback
                        : primary
                      : loads === 1
                        ? primary
                        : fallback);
                  queueMicrotask(() =>
                    this.onmessage?.(
                      new MessageEvent('message', {
                        data: {
                          id: command.id,
                          kind: 'result',
                          value: { loadKind: 'warm', reportedBytes: 0, selected, fallbacks: [] },
                        },
                      }),
                    ),
                  );
                } else {
                  queueMicrotask(() =>
                    this.onmessage?.(
                      new MessageEvent('message', {
                        data: { id: command.id, kind: 'result', value: null },
                      }),
                    ),
                  );
                }
              }
              terminate(): void {}
            }
            globalThis.Worker = LoadWorker as unknown as typeof Worker;
            const arm = new TransformersArm();
            try {
              await arm.load(() => {});
              const first = { ...arm.model };
              await arm.dispose();
              let rejected = false;
              try {
                await arm.load(() => {});
              } catch {
                rejected = true;
              }
              outcomes.push(
                mode === 'retain-fallback'
                  ? !rejected &&
                      first.id === fallback.id &&
                      arm.model.id === first.id &&
                      arm.model.revision === first.revision
                  : rejected && arm.model.id === first.id && arm.model.revision === first.revision,
              );
            } finally {
              await arm.dispose();
            }
          }
        } finally {
          globalThis.Worker = NativeWorker;
        }
        return outcomes;
      }, `${origin}/src/arms/transformers.ts`);
      assert.deepEqual(observations, [true, true]);
    } finally {
      await fixturePage.close();
    }
  });
  await step('Chat record regressions', async () => {
    const fakeArm = `import {MockArm} from '/src/arms/mock.ts';
      export class WebLLMArm extends MockArm {
        constructor() { super(null); this.id = 'webllm'; }
        async probe() { return globalThis.__fixtureLoads >= 2 ? {status:'unavailable',reason:'api_unavailable'} : {status:'available'}; }
        async load(progress) { globalThis.__fixtureLoads = (globalThis.__fixtureLoads ?? 0) + 1; return super.load(progress); }
        guard(operation) { return operation; }
      }`;
    const completedCheck = `import {emptyChatCheck} from '/src/results.ts'; export async function chatWebLLMCheck() { return {...emptyChatCheck('fixture'), status:'completed'}; }`;
    const retryPage = await context.newPage();
    try {
      await retryPage.route('**/src/arms/webllm.ts*', (route) =>
        route.fulfill({ contentType: 'text/javascript', body: fakeArm }),
      );
      await retryPage.route('**/src/chat-webllm-check.ts*', (route) =>
        route.fulfill({ contentType: 'text/javascript', body: completedCheck }),
      );
      const first = await run(retryPage, 'arms=webllm&runs=1&promptApi=probe');
      assert.equal(first.chatWebLLM.status, 'completed');
      await retryPage.getByRole('button', { name: 'Run', exact: true }).click();
      await retryPage.waitForFunction(() => window.spikeB.status().done);
      const second = await retryPage.evaluate(() => window.spikeB.results());
      assert.equal(second.chatWebLLM.status, 'not_run');
      assert.equal(second.chatWebLLM.reason, 'webllm_unavailable');
    } finally {
      await retryPage.close();
    }
    const errorPage = await context.newPage();
    try {
      await errorPage.route('**/src/arms/webllm.ts*', (route) =>
        route.fulfill({ contentType: 'text/javascript', body: fakeArm }),
      );
      await errorPage.route('**/src/chat-webllm-check.ts*', (route) =>
        route.fulfill({
          contentType: 'text/javascript',
          body: "export async function chatWebLLMCheck() { throw new Error('fixture_check_failure'); }",
        }),
      );
      const result = await run(errorPage, 'arms=webllm&runs=1&promptApi=probe');
      assert.equal(result.chatWebLLM.status, 'failed');
      assert.equal(result.chatWebLLM.reason, 'check_exception');
    } finally {
      await errorPage.close();
    }
  });
  if (baseline) {
    await mkdir(`${root}/results`, { recursive: true });
    await writeFile(
      `${root}/results/smoke.json`,
      `${JSON.stringify(resultsSchema.parse(baseline), null, 2)}\n`,
    );
    execFileSync('pnpm', ['exec', 'biome', 'format', '--write', `${root}/results/smoke.json`], {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      stdio: 'pipe',
    });
  }
  assert.equal(pageErrors, 0);
  assert.equal(externalRequests, 0);
  await context.close();
} finally {
  await browser.close();
  await lanServer?.close();
  await server.close();
}
console.log(JSON.stringify(examples));
if (failures.length) process.exitCode = 1;
