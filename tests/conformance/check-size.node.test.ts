// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, onTestFinished, test } from 'vitest';
import {
  compareSizes,
  createBudget,
  discoverEntries,
  measureEntry,
  measureSizes,
  type SizeBudget,
} from '../../scripts/check-size.js';

const entry = '@fixture/public/.';
const budget: SizeBudget = {
  marginPercent: 10,
  entries: { [entry]: { minified: 1_100, gzip: 400 } },
};

function fixture(files: Readonly<Record<string, string>>): string {
  const directory = mkdtempSync(join(tmpdir(), 'galaxie-size-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return directory;
}

test('sizes within budget pass and rows report both sizes and limits in sorted order', () => {
  const measured = {
    '@fixture/second/.': { minified: 200, gzip: 100 },
    [entry]: { minified: 1_000, gzip: 350 },
  };
  const result = compareSizes(measured, {
    ...budget,
    entries: { ...budget.entries, '@fixture/second/.': { minified: 300, gzip: 200 } },
  });
  expect(result.failures).toEqual([]);
  expect(result.rows).toEqual([
    {
      entry,
      minified: 1_000,
      gzip: 350,
      minifiedBudget: 1_100,
      gzipBudget: 400,
      status: 'pass',
    },
    {
      entry: '@fixture/second/.',
      minified: 200,
      gzip: 100,
      minifiedBudget: 300,
      gzipBudget: 200,
      status: 'pass',
    },
  ]);
});

test('sizes exactly at both limits pass', () => {
  expect(compareSizes(budget.entries, budget).failures).toEqual([]);
});

test.each([
  { metric: 'minified', measured: { minified: 1_101, gzip: 350 }, limit: 1_100 },
  { metric: 'gzip', measured: { minified: 1_000, gzip: 401 }, limit: 400 },
])('an exceeded $metric limit names the entry, metric and limit', ({ metric, measured, limit }) => {
  const result = compareSizes({ [entry]: measured }, budget);
  expect(result.rows[0]?.status).toBe('fail');
  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]).toContain(entry);
  expect(result.failures[0]).toContain(metric);
  expect(result.failures[0]).toContain(`${limit} byte limit`);
});

test('both exceeded limits are reported for an entry', () => {
  const result = compareSizes({ [entry]: { minified: 1_101, gzip: 401 } }, budget);
  expect(result.failures).toHaveLength(2);
  expect(result.failures[0]).toContain('minified');
  expect(result.failures[1]).toContain('gzip');
});

test('a measured entry without a budget fails and retains the measured sizes', () => {
  const result = compareSizes(
    { [entry]: { minified: 200, gzip: 100 } },
    { marginPercent: 10, entries: {} },
  );
  expect(result.failures).toEqual([`${entry}: missing size budget.`]);
  expect(result.rows).toEqual([
    {
      entry,
      minified: 200,
      gzip: 100,
      minifiedBudget: undefined,
      gzipBudget: undefined,
      status: 'missing budget',
    },
  ]);
});

test('a stale budget entry fails and appears in the rows', () => {
  const result = compareSizes({}, budget);
  expect(result.failures).toEqual([`${entry}: stale budget entry is not measured.`]);
  expect(result.rows[0]).toMatchObject({ entry, minifiedBudget: 1_100, status: 'stale budget' });
});

test.each([
  [0, 0],
  [1, 100],
  [100, 200],
  [1_000, 1_100],
  [1_001, 1_200],
  [3_000, 3_300],
])('budget generation adds ten percent to %i bytes and rounds up to %i', (bytes, limit) => {
  expect(createBudget({ [entry]: { minified: bytes, gzip: bytes } }, 10)).toEqual({
    marginPercent: 10,
    entries: { [entry]: { minified: limit, gzip: limit } },
  });
});

test('budget generation preserves the configured margin and sorts entry keys', () => {
  const result = createBudget(
    { '@fixture/z/.': { minified: 400, gzip: 200 }, [entry]: { minified: 800, gzip: 400 } },
    25,
  );
  expect(result.marginPercent).toBe(25);
  expect(Object.keys(result.entries)).toEqual([entry, '@fixture/z/.']);
  expect(result.entries[entry]).toEqual({ minified: 1_000, gzip: 500 });
});

test('launch entries come from public manifests and include all default subpaths', () => {
  const directory = fixture({
    'private/package.json': JSON.stringify({ name: '@fixture/private', private: true }),
    'second/package.json': JSON.stringify({
      name: '@fixture/second',
      private: false,
      exports: {
        './worker': { types: './dist/worker.d.ts', default: './dist/worker.js' },
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      },
    }),
    'public/package.json': JSON.stringify({
      name: '@fixture/public',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    }),
  });
  const entries = discoverEntries(directory);
  expect(entries.map((item) => item.entry)).toEqual([
    entry,
    '@fixture/second/.',
    '@fixture/second/worker',
  ]);
  expect(entries[0]).toEqual({
    entry,
    directory: join(directory, 'public'),
    file: join(directory, 'public/dist/index.js'),
  });
  expect(entries[2]?.file).toBe(join(directory, 'second/dist/worker.js'));
});

test('a missing distribution file names the entry and asks for a build', async () => {
  const directory = fixture({});
  await expect(
    measureEntry({ entry, directory, file: join(directory, 'dist/index.js') }),
  ).rejects.toThrow(
    `${entry}: missing ${join(directory, 'dist/index.js')}; run pnpm run build:packages first.`,
  );
});

test('measurement bundles relative imports, keeps bare imports external and is stable', async () => {
  const directory = fixture({
    'package.json': JSON.stringify({
      name: '@fixture/public',
      type: 'module',
      exports: { '.': { default: './dist/index.js' } },
    }),
    // This dependency deliberately does not exist; resolving it would fail the build.
    'dist/index.js': [
      "import { external } from '@fixture/missing-dependency';",
      "import { message } from './message.js';",
      'export const result = external(message);',
      "export const load = () => import('./lazy.js');",
    ].join('\n'),
    'dist/message.js': "export const message = 'relative fixture text';\n",
    'dist/lazy.js': "export const lazy = 'dynamic fixture text';\n",
    'vite.config.js': "throw new Error('Must not load a fixture Vite config');\n",
  });
  const item = { entry, directory, file: join(directory, 'dist/index.js') };
  const first = await measureEntry(item);
  const second = await measureEntry(item);
  expect(first).toEqual(second);
  expect(first.minified).toBeGreaterThan(0);
  expect(first.gzip).toBeGreaterThan(0);
  expect(first.minified).toBe(Buffer.byteLength(first.code));
  expect(first.gzip).toBe(gzipSync(first.code, { level: 9 }).byteLength);
  expect(first.code).toMatch(/import\s*\{[^}]*\}\s*from\s*['"]@fixture\/missing-dependency['"]/);
  expect(first.code).toContain('relative fixture text');
  expect(first.code).toContain('dynamic fixture text');
  expect(first.code).not.toContain('./message.js');
  expect(first.code).not.toContain('./lazy.js');
  expect(await measureSizes([item])).toEqual({
    [entry]: { minified: first.minified, gzip: first.gzip },
  });
  expect(readFileSync(item.file, 'utf8')).toContain("from './message.js'");
}, 30_000);
