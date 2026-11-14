// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import failures from '../../../tests/conformance/langgraph-tool-engine-known-failures.json' with {
  type: 'json',
};
import type { ToolReloadResult } from '../../../tests/conformance/support/python-tool-restore.js';
import {
  buildDspyPage,
  dspyEngine,
  dspyHeader,
  launchDspyEngine,
  selectDspyEngine,
} from './support/dspy-engine.node.js';

let browser: Browser;
let built: Awaited<ReturnType<typeof buildDspyPage>>;
beforeAll(async () => {
  const source = await readFile(
    new URL('../../../tests/conformance/cases-python/tool_loop.py', import.meta.url),
    'utf8',
  );
  const candidate: Record<string, string> = {};
  for (const name of [
    'tool_candidate',
    'tool_scope',
    'tool_scoped_candidate',
    'tool_scoped_floor',
    'tool_identity_probes',
  ])
    candidate[`${name}.py`] = await readFile(
      new URL(`../../../tests/conformance/cases-python/${name}.py`, import.meta.url),
      'utf8',
    );
  built = await buildDspyPage(new URL('./support/python-tool-conformance/', import.meta.url), {
    'tool-loop': { 'tool_loop.py': source },
    candidate,
  });
  browser = await launchDspyEngine();
  console.info(JSON.stringify({ engine: dspyEngine, version: browser.version() }));
}, 900_000);
afterAll(async () => {
  await browser?.close();
  await built?.close();
}, 900_000);

function nativeReference(): { final: string; calls: unknown[]; writes: number } {
  return JSON.parse(
    execFileSync(
      fileURLToPath(new URL('../../../python/.venv/bin/python', import.meta.url)),
      [
        '-I',
        '-c',
        `import asyncio,json,sys
sys.path.insert(0,'tests/conformance/cases-python')
from test_tool_call_replies_native import native_record
record,_=asyncio.run(native_record(write_only=True))
print(json.dumps(record))`,
      ],
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        timeout: 900_000,
        env: { ...process.env, LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).toString(),
  );
}

async function result(page: Page): Promise<ToolReloadResult> {
  await page.waitForFunction(
    () => Reflect.get(globalThis, 'pythonToolConformance')?.done,
    undefined,
    { timeout: 900_000 },
  );
  const report = await page.evaluate(() => Reflect.get(globalThis, 'pythonToolConformance'));
  expect(report.error).toBeUndefined();
  expect(report.violations).toEqual([]);
  expect(report.reload).toBeDefined();
  return report.reload;
}

const titles = [
  ...[false, true].map((replay) => `text protocol reload replay=${replay}`),
  'candidate replayed reads retain effect IDs',
  'candidate abrupt write loss recovers',
];
test('tool engine registry contains only unique registered titles', () => {
  expect(selectDspyEngine(dspyEngine)).toBe(dspyEngine);
  for (const engine of ['chromium', 'firefox', 'webkit'] as const) {
    expect(new Set(failures[engine]).size).toBe(failures[engine].length);
    for (const title of failures[engine])
      expect(titles.map((value) => `${engine} ${value}`)).toContain(title);
  }
});
for (const replay of [false, true]) {
  const title = `${dspyEngine} text protocol reload replay=${replay}`;
  const registered: readonly string[] = failures[dspyEngine];
  (registered.includes(title) ? test.fails : test)(
    title,
    async () => {
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
        const reference = nativeReference();
        const page = await context.newPage();
        await page.goto(`${built.origin}/?replay=${replay}`);
        const first = await result(page);
        expect(first.pending).toBeDefined();
        expect(first.writes).toBe(reference.writes);
        await page.evaluate(
          (session) => sessionStorage.setItem('pythonToolSession', session),
          first.sessionId,
        );
        await page.reload();
        const second = await result(page);
        expect(second.restored).toEqual(first.pending);
        expect(second.pending).toBeUndefined();
        expect(second.final).toEqual({ final: reference.final, calls: reference.calls });
        expect([...first.calls, ...second.calls]).toEqual(reference.calls);
        expect(first.writes + second.writes).toBe(reference.writes);
        expect(external).toEqual([]);
        expect(headers.length).toBeGreaterThan(0);
        expect(headers.every((header) => header === dspyHeader)).toBe(true);
      } finally {
        await context.close();
      }
    },
    900_000,
  );
}

interface CandidateResult {
  sessionId: string;
  effects: string[];
  calls: unknown[];
  scopes: string[];
  receipts: unknown[];
  pending?: unknown;
  restored?: unknown;
  final?: unknown;
  crashReady?: boolean;
  restoreMissing?: boolean;
  startCode?: string;
}
const candidateRuns = new Map<string, Promise<[CandidateResult, CandidateResult]>>();
function candidateRun(probe: string): Promise<[CandidateResult, CandidateResult]> {
  const previous = candidateRuns.get(probe);
  if (previous) return previous;
  const run = (async (): Promise<[CandidateResult, CandidateResult]> => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const external: string[] = [];
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === built.origin) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    try {
      const page = await context.newPage();
      const read = async (): Promise<CandidateResult> => {
        await page.waitForFunction(
          () => Reflect.get(globalThis, 'pythonToolConformance')?.done,
          undefined,
          { timeout: 900_000 },
        );
        const report = await page.evaluate(() => Reflect.get(globalThis, 'pythonToolConformance'));
        expect(report.error).toBeUndefined();
        expect(report.violations).toEqual([]);
        expect(report.candidate).toBeDefined();
        return report.candidate;
      };
      await page.goto(`${built.origin}/?probe=${probe}`);
      const first = await read();
      await page.evaluate(
        (step) => sessionStorage.setItem('pythonToolCandidateStep', JSON.stringify(step)),
        first,
      );
      await page.reload();
      const second = await read();
      expect(external).toEqual([]);
      return [first, second];
    } finally {
      await context.close();
    }
  })();
  candidateRuns.set(probe, run);
  return run;
}

test.skipIf(dspyEngine !== 'chromium')(
  'candidate parallel replay observations identify the read counterexample',
  async () => {
    const [first, second] = await candidateRun('reads');
    expect(first.pending).toBeDefined();
    expect(second.restored).toEqual(first.pending);
    expect(first.effects).toHaveLength(2);
    expect(new Set(first.effects).size).toBe(2);
    expect(second.effects).toHaveLength(2);
    expect(second.effects.every((id) => !first.effects.includes(id))).toBe(true);
    expect(second.scopes).toEqual(first.scopes);
    expect(second.final).toMatchObject({ final: 'done' });
  },
  900_000,
);

test.skipIf(dspyEngine !== 'chromium')(
  'candidate parallel write receipts survive real reload and replay',
  async () => {
    const [first, second] = await candidateRun('writes');
    expect(first.pending).toBeDefined();
    expect(second.restored).toEqual(first.pending);
    expect(first.effects).toHaveLength(2);
    expect(new Set(first.effects).size).toBe(2);
    expect(first.receipts).toHaveLength(2);
    expect(
      first.receipts.every((record) => (record as { status: string }).status === 'succeeded'),
    ).toBe(true);
    expect(second.receipts).toEqual(first.receipts);
    expect(second.effects).toEqual([]);
    expect(second.calls).toEqual([]);
    expect(second.scopes).toEqual(first.scopes);
    expect(second.final).toMatchObject({ final: 'done' });
  },
  900_000,
);

test.skipIf(dspyEngine !== 'chromium')(
  'candidate abrupt-loss observation keeps receipt but refuses adopted-session restart',
  async () => {
    const [first, second] = await candidateRun('crash');
    expect(first.crashReady).toBe(true);
    expect(first.effects).toHaveLength(1);
    expect(first.receipts).toMatchObject([{ status: 'succeeded' }]);
    expect(second.receipts).toEqual(first.receipts);
    expect(second.restoreMissing).toBe(true);
    expect(second.startCode).toBe('invalid');
    expect(second.calls).toEqual([]);
  },
  900_000,
);

for (const [description, probe] of [
  ['candidate replayed reads retain effect IDs', 'reads'],
  ['candidate abrupt write loss recovers', 'crash'],
]) {
  const title = `${dspyEngine} ${description}`;
  const registered: readonly string[] = failures[dspyEngine];
  const run = async (): Promise<void> => {
    const [first, second] = await candidateRun(probe ?? '');
    if (probe === 'reads') expect(second.effects).toEqual(first.effects);
    else expect(second.restoreMissing).toBe(false);
  };
  if (dspyEngine !== 'chromium') test.skip(title, run);
  else (registered.includes(title) ? test.fails : test)(title, run, 900_000);
}
