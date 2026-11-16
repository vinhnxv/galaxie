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
      'packages/starter-go/src/resolve.ts',
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
    'packages/starter-python/src/verify.ts',
    'templates/frameworks/langgraph-python/files/vite.framework.ts',
    'tests/conformance/starter-python-gateway.node.test.ts',
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

test('Python shards partition the Node inventory and keep composed browser files out of Node', () => {
  const list = (group?: string): string[] => {
    const env = { ...process.env };
    if (group === undefined) delete env['GALAXIE_TEST_GROUP'];
    else env['GALAXIE_TEST_GROUP'] = group;
    const result = spawnSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'list', '--project', 'node', '--filesOnly', '--json'],
      { encoding: 'utf8', env },
    );
    expect(result.status, result.stderr).toBe(0);
    return (JSON.parse(result.stdout) as { file: string }[]).map(({ file }) =>
      file.replaceAll('\\', '/'),
    );
  };
  const all = list();
  const groups = ['general', 'python-dspy', 'python-pydantic', 'python-adk', 'python-rest'];
  const inventories = groups.map((group) => list(group));
  const assigned = inventories.flat();
  expect(assigned.length).toBe(new Set(assigned).size);
  expect([...assigned].sort()).toEqual([...all].sort());
  const starter = inventories[4] ?? [];
  expect(
    starter.filter((file) => file.includes('/tests/conformance/starter-python-')),
  ).toHaveLength(4);
  const composed = starter.filter(
    (file) => file.includes('/composed/') && file.includes('-langgraph-python/test/'),
  );
  expect(composed).toHaveLength(8);
  expect(
    composed.every(
      (file) => file.includes('-langgraph-python/test/') && file.endsWith('.node.test.ts'),
    ),
  ).toBe(true);
  for (const file of starter) expect(file).not.toMatch(/\/app\.test\.ts$/);
}, 60_000);
