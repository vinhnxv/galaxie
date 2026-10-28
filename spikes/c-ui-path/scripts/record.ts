// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import type { SpikeHandle } from '../src/app.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'http://127.0.0.1:4176';
const results = `${root}/results`;
await mkdir(results, { recursive: true });
const graphSource = await readFile(`${root}/src/graph.ts`, 'utf8');
const sentinel = /marker: '([^']+)'/.exec(graphSource)?.[1];
assert.ok(sentinel, 'The answer-key sentinel must be found for the exposure check.');
const requests = new Set<string>();
const failures: string[] = [];
type Result = { status: 'passed' | 'failed' | 'skipped'; observed: Record<string, unknown> };
const examples: Record<string, Result> = {};
const extras: Record<string, Result> = {};
let browserErrors = 0;
async function step(
  target: Record<string, Result>,
  id: string,
  run: (observed: Record<string, unknown>) => Promise<void>,
  dependency?: string,
): Promise<void> {
  const observed: Record<string, unknown> = {};
  if (dependency && examples[dependency]?.status !== 'passed') {
    target[id] = { status: 'skipped', observed: { reason: `Requires ${dependency}.` } };
    failures.push(id);
    return;
  }
  try {
    await run(observed);
    target[id] = { status: 'passed', observed };
  } catch {
    // Never serialize thrown assertions: their values could include private graph state.
    target[id] = { status: 'failed', observed };
    failures.push(id);
  }
  console.log(`${id}: ${target[id]?.status}`);
}
function observe(page: Page): void {
  page.on('request', (request) => requests.add(request.url()));
  page.on('pageerror', () => browserErrors++);
  page.setDefaultTimeout(10_000);
}
async function snapshot(page: Page): Promise<ReturnType<SpikeHandle['snapshot']>> {
  return page.evaluate(() => window.spikeC.snapshot());
}
async function waiting(page: Page): Promise<void> {
  await page.getByTestId('quiz').waitFor();
  await page.waitForFunction(() => window.spikeC.snapshot().run?.status === 'waiting_input');
}
function identity(value: ReturnType<SpikeHandle['snapshot']>): Record<string, unknown> {
  return {
    instanceId: value.instanceId,
    runId: value.run?.runId,
    status: value.run?.status,
    interactionId: value.run?.pending?.interactionId,
    surfaceId: value.run?.pending?.surfaceId,
    viewRevision: value.run?.pending?.viewRevision,
    component: value.run?.pending?.component,
  };
}
function receipt(value: Awaited<ReturnType<SpikeHandle['dispatch']>>): Record<string, unknown> {
  return value.status === 'accepted'
    ? { status: value.status, interactionId: value.interactionId }
    : { status: value.status, code: value.error.code };
}
const server = await createServer({ configFile: `${root}/vite.config.ts` });
await server.listen();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 800, height: 600 },
  recordVideo: { dir: `${root}/recordings`, size: { width: 800, height: 600 } },
});
const page = await context.newPage();
observe(page);
let before: ReturnType<SpikeHandle['snapshot']> | undefined;
let restored: ReturnType<SpikeHandle['snapshot']> | undefined;
let singleCopy: Awaited<ReturnType<SpikeHandle['singleCopy']>> | undefined;
let videoBytes: number | undefined;
let videoCommitted = false;
try {
  await step(examples, 'AE1', async (observed) => {
    await page.goto(origin);
    await waiting(page);
    before = await snapshot(page);
    singleCopy = await page.evaluate(() => window.spikeC.singleCopy());
    const leak = await page.evaluate((marker) => {
      const serialized = [
        JSON.stringify(window.spikeC.snapshot()),
        window.spikeC.exposure(),
        document.body.innerHTML,
      ].join('\n');
      return { marker: serialized.includes(marker), field: serialized.includes('answerKey') };
    }, sentinel);
    const questions = await page.locator('[data-testid="quiz"] fieldset').count();
    const propsMatch = await page.evaluate(() => {
      const props = window.spikeC.snapshot().run?.pending?.props as {
        questions: { prompt: string; options: string[] }[];
      };
      const fields = [...document.querySelectorAll('[data-testid="quiz"] fieldset')];
      return props.questions.every(
        (question, index) =>
          fields[index]?.querySelector('legend')?.textContent === question.prompt &&
          question.options.every((option) => fields[index]?.textContent?.includes(option)),
      );
    });
    Object.assign(observed, identity(before), {
      questions,
      propsMatch,
      exposure: leak,
      counters: await page.evaluate(() => window.spikeC.counters()),
      singleCopy: singleCopy.ok,
    });
    assert.equal(questions, 3);
    assert.ok(propsMatch && singleCopy.ok && !leak.marker && !leak.field);
    assert.equal(before.run?.pending?.component, 'education.Quiz/v1');
  });

  await step(
    examples,
    'AE3',
    async (observed) => {
      assert.ok(before?.run?.pending);
      const pending = before.run.pending;
      const codes: string[] = [];
      for (const kind of ['unknown', 'props'] as const) {
        const code = await page.evaluate(
          ({ pending, kind }) => {
            const candidate =
              kind === 'unknown'
                ? { ...pending, component: 'education.Unknown/v1' as const }
                : {
                    ...pending,
                    props: {
                      questions: (pending.props as { questions: unknown[] }).questions.slice(1),
                    },
                  };
            return window.spikeC.renderProbe(candidate);
          },
          { pending, kind },
        );
        codes.push(code);
        await page.getByTestId('probe-error').waitFor();
        assert.equal(
          await page.getByTestId('probe-error').getAttribute('data-code'),
          kind === 'unknown' ? 'unknown_component' : 'invalid_props',
        );
        assert.equal(await page.getByTestId('probe').getByTestId('quiz').count(), 0);
      }
      const dispatches = await page.evaluate(() => window.spikeC.counters().dispatches);
      const action = await page.evaluate(() => window.spikeC.submit('skip', {}));
      await page.getByTestId('action-error').waitFor();
      const after = await snapshot(page);
      Object.assign(observed, {
        codes: { unknown: codes[0], props: codes[1] },
        action:
          action.status === 'rejected'
            ? { status: action.status, code: action.error.code }
            : { status: action.status },
        coreDispatches:
          (await page.evaluate(() => window.spikeC.counters().dispatches)) - dispatches,
        ...identity(after),
      });
      assert.equal(action.status === 'rejected' && action.error.code, 'invalid_action');
      assert.equal(
        await page.getByTestId('action-error').getAttribute('data-code'),
        'invalid_action',
      );
      assert.equal(await page.evaluate(() => window.spikeC.counters().dispatches), dispatches);
      assert.equal(after.run?.status, 'waiting_input');
      assert.equal(after.run?.pending?.interactionId, pending.interactionId);
    },
    'AE1',
  );

  await step(
    examples,
    'AE2',
    async (observed) => {
      const checkpointCount = await page.evaluate(() => window.spikeC.counters().checkpointCount);
      const receipts = await page.evaluate(async () => {
        const value = window.spikeC.snapshot();
        const pending = value.run?.pending;
        if (!value.run || !pending) throw new Error('Missing pending interaction.');
        const event = {
          instanceId: value.instanceId,
          runId: value.run.runId,
          ...pending,
          action: 'submit',
          payload: {},
        };
        return Promise.all(
          ['instanceId', 'runId', 'interactionId', 'surfaceId', 'viewRevision'].map((field) =>
            window.spikeC.dispatch({ ...event, [field]: 'forged' }),
          ),
        );
      });
      const after = await snapshot(page);
      const afterCount = await page.evaluate(() => window.spikeC.counters().checkpointCount);
      Object.assign(observed, {
        receipts: receipts.map(receipt),
        checkpointCount,
        afterCount,
        ...identity(after),
      });
      assert.ok(
        receipts.every((value) => value.status === 'rejected' && value.error.code === 'stale'),
      );
      assert.equal(after.run?.status, 'waiting_input');
      assert.equal(after.run?.pending?.interactionId, before?.run?.pending?.interactionId);
      assert.equal(afterCount, checkpointCount);
    },
    'AE1',
  );

  await step(
    examples,
    'AE4',
    async (observed) => {
      await page.getByTestId('q1-0').check();
      assert.equal(await page.locator('input:checked').count(), 1);
      await page.screenshot({ path: `${results}/before-reload.png`, fullPage: true });
      await page.reload();
      await waiting(page);
      restored = await snapshot(page);
      const counters = await page.evaluate(() => window.spikeC.counters());
      const checked = await page.locator('input:checked').count();
      const samePending =
        JSON.stringify(before?.run?.pending) === JSON.stringify(restored.run?.pending);
      Object.assign(observed, identity(restored), { samePending, checked, counters });
      assert.ok(samePending);
      assert.equal(checked, 0);
      assert.equal(counters.generationRuns, 1);
      assert.equal(await page.getByTestId('mode').textContent(), 'Restored');
      await page.screenshot({ path: `${results}/after-reload.png`, fullPage: true });
    },
    'AE1',
  );

  await step(
    examples,
    'AE5',
    async (observed) => {
      assert.ok(before);
      const oldReceipt = await page.evaluate(async (old) => {
        const value = window.spikeC.snapshot();
        const pending = value.run?.pending;
        if (!pending || !old.run) throw new Error('Missing pending interaction.');
        return window.spikeC.dispatch({
          ...pending,
          instanceId: old.instanceId,
          runId: old.run.runId,
          action: 'submit',
          payload: {},
        });
      }, before);
      const receipts = await page.evaluate(async () => {
        const value = window.spikeC.snapshot();
        const pending = value.run?.pending;
        if (!pending || !value.run) throw new Error('Missing pending interaction.');
        const questions = (pending.props as { questions: { id: string; options: string[] }[] })
          .questions;
        // A fixed, independently chosen option pattern, never read from the answer key.
        const answers = Object.fromEntries(
          questions.map((question, index) => [question.id, question.options[index]]),
        );
        const event = {
          instanceId: value.instanceId,
          runId: value.run.runId,
          ...pending,
          action: 'submit',
          payload: { answers },
        };
        const first = window.spikeC.dispatch(event);
        const second = window.spikeC.dispatch(event);
        return Promise.all([first, second]);
      });
      await page.getByTestId('result').waitFor();
      const after = await snapshot(page);
      const counters = await page.evaluate(() => window.spikeC.counters());
      const scoreVisible = await page.getByTestId('result').textContent();
      Object.assign(observed, {
        oldReceipt: receipt(oldReceipt),
        receipts: receipts.map(receipt),
        ...identity(after),
        counters,
        scoreVisible,
        newInstanceId: before.instanceId !== restored?.instanceId,
        newRunId: before.run?.runId !== restored?.run?.runId,
      });
      assert.equal(oldReceipt.status === 'rejected' && oldReceipt.error.code, 'stale');
      assert.equal(receipts.filter((value) => value.status === 'accepted').length, 1);
      assert.equal(receipts.filter((value) => value.status === 'rejected').length, 1);
      assert.equal(after.run?.status, 'succeeded');
      assert.equal(scoreVisible, 'Score: 3 / 3');
      assert.equal(counters.generationRuns, 1);
      const exposed = await page.evaluate(() => window.spikeC.exposure());
      assert.ok(!exposed.includes(sentinel) && !exposed.includes('answerKey'));
    },
    'AE4',
  );

  // Separate UI double-click and exhausted-checkpoint probes do not alter the main recording.
  await step(extras, 'button-double-click', async (observed) => {
    const other = await browser.newContext({ viewport: { width: 800, height: 600 } });
    try {
      const testPage = await other.newPage();
      observe(testPage);
      await testPage.goto(origin);
      await waiting(testPage);
      for (let index = 0; index < 3; index++)
        await testPage.getByTestId(`q${index + 1}-${index}`).check();
      const count = await testPage.evaluate(() => window.spikeC.counters().dispatches);
      await testPage.getByRole('button', { name: 'Submit answers' }).dblclick();
      await testPage.getByTestId('result').waitFor();
      const dispatches =
        (await testPage.evaluate(() => window.spikeC.counters().dispatches)) - count;
      Object.assign(observed, { coreDispatches: dispatches });
      assert.equal(dispatches, 1);
      await testPage.reload();
      await testPage.getByTestId('run-error').waitFor();
      const code = await testPage.getByTestId('run-error').getAttribute('data-code');
      Object.assign(observed, { exhaustedRestore: code });
      assert.equal(code, 'unsupported');
    } finally {
      await other.close();
    }
  });

  await step(examples, 'AE6', async (observed) => {
    const other = await browser.newContext();
    try {
      const testPage = await other.newPage();
      observe(testPage);
      await testPage.goto(`${origin}/?variant=url`);
      await waiting(testPage);
      const fresh = await snapshot(testPage);
      await testPage.reload();
      await testPage.getByTestId('run-error').waitFor();
      const after = await snapshot(testPage);
      Object.assign(observed, {
        freshStatus: fresh.run?.status,
        restoredStatus: after.run?.status,
        code: after.run?.error?.code,
        pending: after.run?.pending !== undefined,
        counters: await testPage.evaluate(() => window.spikeC.counters()),
      });
      assert.equal(after.run?.status, 'failed');
      assert.equal(after.run?.error?.code, 'denied');
      assert.equal(after.run?.pending, undefined);
      assert.equal(await testPage.getByTestId('run-error').getAttribute('data-code'), 'denied');
    } finally {
      await other.close();
    }
  });

  await step(examples, 'AE7', async (observed) => {
    Object.assign(observed, { requestCount: requests.size, browserErrors });
    assert.ok(requests.size > 0 && [...requests].every((url) => url.startsWith(`${origin}/`)));
    assert.equal(browserErrors, 0);
  });
} finally {
  await context.close();
  const video = await page.video()?.path();
  if (video) {
    videoBytes = (await stat(video)).size;
    if (videoBytes <= 3_000_000) {
      await copyFile(video, `${results}/run.webm`);
      videoCommitted = true;
    }
  }
  await browser.close();
  await server.close();
  const manifest = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  const log = {
    date: new Date().toISOString(),
    chromium: browser.version(),
    packages: { ...manifest.dependencies, ...manifest.devDependencies },
    examples,
    extras,
    singleCopy,
    requestUrls: [...requests].sort(),
    video: { bytes: videoBytes, committed: videoCommitted },
  };
  await writeFile(`${results}/run-log.json`, `${JSON.stringify(log, null, 2)}\n`);
}
if (failures.length > 0) process.exitCode = 1;
