// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';
import { createAffected, pythonAffected } from '../../scripts/ci-scope.js';

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
      'examples/nextjs-app-router/src/host.tsx',
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

test('only a non-empty documents-only change list skips the create jobs', () => {
  expect(createAffected(['README.md', 'docs/x.md', 'docs/data.json', 'llms.txt'])).toBe(false);
  expect(createAffected(['  docs/x.md  ', '', '  '])).toBe(false);
  for (const file of [
    'packages/core/src/index.ts',
    '.github/workflows/ci.yml',
    'scripts/standalone-core.ts',
    'LICENSE',
    'go/go.mod',
    'llms.txt.bak',
  ])
    expect(createAffected(['docs/x.md', file]), file).toBe(true);
  expect(createAffected([])).toBe(true);
  expect(createAffected(['', '  '])).toBe(true);
});

test('the command prints both GitHub output lines in order', () => {
  const run = (input: string): string =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../../scripts/ci-scope.ts', import.meta.url))],
      {
        input,
        encoding: 'utf8',
      },
    ).stdout.trim();
  expect(run('docs/a.md\nllms.txt\n')).toBe('python=false\ncreate=false');
  expect(run('docs/a.md\npackages/core/src/index.ts\n')).toBe('python=true\ncreate=true');
  expect(run('go/go.mod\n')).toBe('python=false\ncreate=true');
  expect(run('')).toBe('python=true\ncreate=true');
  expect(run('\n  \n')).toBe('python=true\ncreate=true');
});

test('Python shards partition the Node inventory and keep composed browser files out of Node', async () => {
  const fixture = await mkdtemp('packages/create/.cache/composed/.starter-python-inventory-');
  onTestFinished(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'test'));
  await writeFile(join(fixture, 'test/inventory.node.test.ts'), 'export {};\n');
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
  for (const file of all) expect(file).not.toMatch(/\/composed\/\./);
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

test('the Python starter browser project lists only the composed app tests, in the Python groups only', async () => {
  // Another run may hold the project's default API port, so list on a free one.
  const probe = createNetServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('No free port.');
  const port = address.port;
  await new Promise<void>((done) => probe.close(() => done()));
  const list = (group?: string): string[] => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GALAXIE_PYTHON_STARTER_API_PORT: String(port),
    };
    if (group === undefined) delete env['GALAXIE_TEST_GROUP'];
    else env['GALAXIE_TEST_GROUP'] = group;
    const result = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'list',
        '--project',
        'python-starter-browser',
        '--filesOnly',
        '--json',
      ],
      { encoding: 'utf8', env },
    );
    expect(result.status, result.stderr).toBe(0);
    return (JSON.parse(result.stdout) as { file: string }[]).map(({ file }) =>
      file.replaceAll('\\', '/'),
    );
  };
  const isStarterApp = (file: string): boolean =>
    file.includes('-langgraph-python/test/') && file.endsWith('/app.test.ts');
  // Every listed file is a composed starter app test, so none repeats a main browser file.
  for (const group of [undefined, 'python', 'python-rest']) {
    const files = list(group);
    expect(files, String(group)).toHaveLength(2);
    expect(files.every(isStarterApp), String(group)).toBe(true);
  }
  for (const group of ['general', 'python-dspy', 'python-pydantic', 'python-adk'])
    expect(list(group), group).toEqual([]);
}, 120_000);
