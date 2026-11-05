// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { init, parse } from 'es-module-lexer';
import { expect, test } from 'vitest';

const ADK_VERSION = '2.3.0';
const BUNDLE_SHA256 = 'e5090e3c76b35fbeba9d07403e0e534732f12ae586bed9f5558c09d4170ea199';

const require = createRequire(import.meta.url);
const packageDirectory = dirname(require.resolve('@google/adk/package.json'));

const bundleSource = readFile(join(packageDirectory, 'dist/web/index_web.js'), 'utf8');

test('the installed release is the pinned one', async () => {
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as {
    version: string;
    exports: Record<string, Record<string, string>>;
  };
  expect(manifest.version).toBe(ADK_VERSION);
  expect(manifest.exports['.']?.['browser']).toBe('./dist/web/index_web.js');
});

test('the web bundle file is byte-identical to the reviewed one', async () => {
  expect(
    createHash('sha256')
      .update(await bundleSource)
      .digest('hex'),
  ).toBe(BUNDLE_SHA256);
});

test('the web bundle imports nothing from outside itself', async () => {
  await init;
  const [imports] = parse(await bundleSource);
  expect(imports.map((entry) => entry.n)).toEqual([]);
});

test('the web bundle exports the symbols the adapter depends on', async () => {
  await init;
  const [, exports] = parse(await bundleSource);
  const names = new Set(exports.map((entry) => entry.n));
  for (const name of [
    'BaseLlm',
    'BaseSessionService',
    'FunctionTool',
    'InMemoryRunner',
    'LlmAgent',
    'LongRunningFunctionTool',
    'LoopAgent',
    'ParallelAgent',
    'Runner',
    'SequentialAgent',
    'StreamingMode',
    'ToolCallIntegrityPlugin',
    'ToolConfirmation',
    'requestInputTool',
  ])
    expect(names, name).toContain(name);
});
