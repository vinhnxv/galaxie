// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { expect, test } from 'vitest';
import type { LockedWheel } from '../../packages/adapter-pyodide/src/runtime-files.js';
import * as inventory from '../../packages/adapter-pyodide/src/runtime-files.js';

const packageUrl = new URL('../../packages/adapter-pyodide/package.json', import.meta.url);
const manifest = JSON.parse(readFileSync(packageUrl, 'utf8')) as {
  exports: Record<string, { types: string; default: string }>;
};
const expectedExport = {
  types: './dist/runtime-files.d.ts',
  default: './dist/runtime-files.js',
};
const expectedRuntimeFiles = [
  { file: 'pyodide.mjs', bytes: 17_931 },
  { file: 'pyodide.asm.mjs', bytes: 1_250_344 },
  { file: 'pyodide.asm.wasm', bytes: 9_598_218 },
  { file: 'python_stdlib.zip', bytes: 2_545_637 },
];
const lock = JSON.parse(
  readFileSync(new URL('../../python/requirements.lock', import.meta.url), 'utf8'),
) as { packages: { name: string; version: string }[] };
const versions = (wheels: readonly { name: string; version: string }[]): string[] =>
  wheels.map(({ name, version }) => `${name}@${version}`).sort();
const expectedVersions = versions(lock.packages);

function inventoryProblems(
  exports: typeof manifest.exports,
  runtimeFiles: typeof inventory.runtimeFiles,
  wheels: readonly LockedWheel[],
): string[] {
  const problems: string[] = [];
  if (!isDeepStrictEqual(exports['./runtime-files'], expectedExport)) problems.push('export');
  if (!isDeepStrictEqual(runtimeFiles, expectedRuntimeFiles)) problems.push('runtime-files');
  if (!isDeepStrictEqual(versions(wheels), expectedVersions)) problems.push('wheel-versions');
  if (new Set(wheels.map(({ name }) => name)).size !== wheels.length)
    problems.push('duplicate-wheels');
  if (wheels.some(({ file }) => !file.endsWith('.whl'))) problems.push('wheel-files');
  return problems;
}

test('the runtime-files subpath exposes exactly the worker inventories without a build', () => {
  expect(Object.keys(inventory).sort()).toEqual(['lockedWheels', 'runtimeFiles']);
  expect(
    inventoryProblems(manifest.exports, inventory.runtimeFiles, inventory.lockedWheels),
  ).toEqual([]);
  const config = JSON.parse(
    readFileSync(
      new URL('../../packages/adapter-pyodide/tsconfig.build.json', import.meta.url),
      'utf8',
    ),
  ) as { compilerOptions: { rootDir: string; outDir: string } };
  expect(config.compilerOptions.rootDir).toBe('src');
  expect(config.compilerOptions.outDir).toBe('dist');
  const target = manifest.exports['./runtime-files']?.default;
  expect(target).toBe(expectedExport.default);
  expect(
    existsSync(
      new URL(target?.replace('./dist/', './src/').replace(/\.js$/, '.ts') ?? '', packageUrl),
    ),
  ).toBe(true);
});

test('runtime byte pins match the installed runtime files', () => {
  const require = createRequire(packageUrl);
  const directory = dirname(require.resolve('pyodide/package.json'));
  for (const { file, bytes } of expectedRuntimeFiles)
    expect(statSync(join(directory, file)).size, file).toBe(bytes);
});

test('inventory checks detect a missing export, missing runtime, changed bytes and missing wheel', () => {
  const { './runtime-files': omitted, ...withoutExport } = manifest.exports;
  expect(omitted).toEqual(expectedExport);
  expect(inventoryProblems(withoutExport, inventory.runtimeFiles, inventory.lockedWheels)).toEqual([
    'export',
  ]);
  expect(
    inventoryProblems(manifest.exports, inventory.runtimeFiles.slice(1), inventory.lockedWheels),
  ).toEqual(['runtime-files']);
  const changedBytes = expectedRuntimeFiles.map((entry, index) =>
    index === 0 ? { ...entry, bytes: entry.bytes + 1 } : entry,
  );
  expect(inventoryProblems(manifest.exports, changedBytes, inventory.lockedWheels)).toEqual([
    'runtime-files',
  ]);
  expect(
    inventoryProblems(manifest.exports, inventory.runtimeFiles, inventory.lockedWheels.slice(1)),
  ).toEqual(['wheel-versions']);
  const first = inventory.lockedWheels[0];
  if (first === undefined) throw new Error('Missing wheel fixture.');
  expect(
    inventoryProblems(manifest.exports, inventory.runtimeFiles, [...inventory.lockedWheels, first]),
  ).toEqual(['wheel-versions', 'duplicate-wheels']);
  expect(
    inventoryProblems(
      manifest.exports,
      inventory.runtimeFiles,
      inventory.lockedWheels.map((wheel, index) =>
        index === 0 ? { ...wheel, file: 'invalid.zip' } : wheel,
      ),
    ),
  ).toEqual(['wheel-files']);
});
