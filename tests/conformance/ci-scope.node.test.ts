// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { pythonAffected } from '../../scripts/ci-scope.js';

test('a change confined to documents, Go and unrelated packages skips the Python jobs', () => {
  expect(
    pythonAffected([
      'docs/adr/0023-google-adk-go-through-a-wasm-worker.md',
      'README.md',
      'packages/adapter-go/src/index.ts',
      'go/galaxie/record.go',
      'tests/conformance/golden-adk-go/parallel.json',
      'tests/conformance/adk-go-restore.node.test.ts',
      'examples/host-local/src/main.ts',
      'llms.txt',
    ]),
  ).toBe(false);
});

test('any path that a Python test can read runs the Python jobs', () => {
  for (const file of [
    'python/galaxie/src/galaxie/adk.py',
    'python/uv.lock',
    'packages/core/src/index.ts',
    'packages/models/src/mock.ts',
    'packages/adapter-pyodide/src/adapter.ts',
    'packages/adapter-adk/src/index.ts',
    'examples/rag-browser/src/main.ts',
    'examples/rag-browser/test/support/adk-go-ref/run.ts',
    'tests/conformance/support/transcript.ts',
    'vitest.config.ts',
    'package.json',
    'pnpm-lock.yaml',
    'scripts/fetch-python-wheels.ts',
    '.github/workflows/ci.yml',
    '.github/actions/setup/action.yml',
  ])
    expect(pythonAffected([file]), file).toBe(true);
  // One affecting file among independent ones is enough.
  expect(pythonAffected(['docs/a.md', 'packages/core/src/index.ts'])).toBe(true);
});

test('an empty or blank change list runs the Python jobs', () => {
  expect(pythonAffected([])).toBe(true);
  expect(pythonAffected(['', '  '])).toBe(true);
});

test('the command prints the GitHub output line', () => {
  const run = (input: string): string =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../../scripts/ci-scope.ts', import.meta.url))],
      {
        input,
        encoding: 'utf8',
      },
    ).stdout.trim();
  expect(run('docs/a.md\nllms.txt\n')).toBe('python=false');
  expect(run('docs/a.md\npackages/core/src/index.ts\n')).toBe('python=true');
  expect(run('')).toBe('python=true');
});
