// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { beforeEach, expect, test, vi } from 'vitest';
import { goAssets } from '../src/host/go-assets.js';
import { pythonAssets } from '../src/host/python-assets.js';

const fixture = vi.hoisted(() => ({
  files: new Map<string, string>(),
  pythonSource: false,
  goSource: false,
  goInstalled: true,
  builds: 0,
  goPackage: '',
  pythonFiles: ['example.py'],
}));
const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
vi.mock('node:fs', () => ({
  existsSync: (path: string) =>
    fixture.files.has(path) ||
    (fixture.pythonSource && path.endsWith('/agent_py/')) ||
    (fixture.goSource && path.endsWith('/go/recipes/financial/')),
  readdirSync: (path: string) =>
    fixture.pythonFiles.map((file) => ({
      name: file.slice(file.lastIndexOf('/') + 1),
      parentPath: file.includes('/') ? join(path, file.slice(0, file.lastIndexOf('/'))) : path,
      isFile: () => true,
    })),
  readFileSync: (path: string, encoding?: string) => {
    const text = fixture.files.get(path);
    if (text === undefined) throw new Error('The synthetic asset is missing.');
    return encoding === undefined ? Buffer.from(text) : text;
  },
}));
vi.mock('../../../packages/adapter-pyodide/src/runtime-files.js', () => ({
  lockedWheels: [
    {
      name: 'adk',
      version: '0.0.0',
      file: 'adk.whl',
      bytes: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      frameworks: ['adk'],
    },
    {
      name: 'other',
      version: '0.0.0',
      file: 'other.whl',
      bytes: 3,
      sha256: '',
      frameworks: ['dspy'],
    },
  ],
  runtimeFiles: [{ file: 'pyodide.mjs', bytes: 3 }],
}));
vi.mock('../../../scripts/build-go-wasm.ts', () => ({
  buildGoWasm: async (packagePath: string) => {
    fixture.builds++;
    fixture.goPackage = packagePath;
    return { file: '/synthetic/financial.wasm', bytes: 3, sha256: 'synthetic-wasm-digest' };
  },
}));
vi.mock('../../../scripts/fetch-go-glue.ts', () => ({
  fetchGoGlue: async () => '/synthetic/wasm_exec.js',
}));
vi.mock('../../../scripts/go-wasm-lock.ts', () => ({ goInstalled: () => fixture.goInstalled }));

const root = fileURLToPath(new URL('../../../', import.meta.url));
const agent = join(root, 'examples/adk-recipes/agent_py');
const cache = '/synthetic/wheels';

function harness(plugin: Plugin): {
  readonly emitted: { fileName: string; source: Uint8Array }[];
  call(
    name: 'configResolved' | 'buildStart' | 'load' | 'generateBundle',
    ...args: unknown[]
  ): Promise<unknown>;
} {
  const emitted: { fileName: string; source: Uint8Array }[] = [];
  return {
    emitted,
    async call(name, ...args) {
      const hook = plugin[name];
      if (hook === undefined) return undefined;
      const handler = typeof hook === 'function' ? hook : hook.handler;
      return Reflect.apply(
        handler,
        { emitFile: (asset: { fileName: string; source: Uint8Array }) => emitted.push(asset) },
        args,
      );
    },
  };
}

function metadata(source: unknown): Record<string, unknown> {
  if (typeof source !== 'string') throw new Error('The virtual module is missing.');
  const json = source.slice(source.indexOf(' = ') + 3, -1);
  return JSON.parse(json) as Record<string, unknown>;
}

beforeEach(() => {
  fixture.files.clear();
  fixture.pythonSource = true;
  fixture.goSource = true;
  fixture.goInstalled = true;
  fixture.builds = 0;
  fixture.goPackage = '';
  fixture.pythonFiles = ['example.py'];
  fixture.files.set(
    join(cache, 'local-wheels.json'),
    JSON.stringify({
      packages: [
        { name: 'galaxie', version: '0.0.0', file: 'galaxie.whl', bytes: 3, sha256: digest },
        { name: 'unrelated', file: 'unrelated.whl', bytes: 3, sha256: '', frameworks: ['dspy'] },
      ],
    }),
  );
  fixture.files.set(join(cache, 'adk.whl'), 'abc');
  fixture.files.set(join(cache, 'galaxie.whl'), 'abc');
  fixture.files.set(join(root, 'packages/adapter-pyodide/node_modules/pyodide/pyodide.mjs'), 'abc');
  fixture.files.set(join(agent, 'example.py'), '# Synthetic module\n');
  fixture.files.set('/synthetic/financial.wasm', 'abc');
  fixture.files.set('/synthetic/wasm_exec.js', 'abc');
});

test('Python build includes the unscoped local bridge, ADK wheels and same-origin sources', async () => {
  const run = harness(pythonAssets(cache));
  await run.call('configResolved', { command: 'build' });
  await run.call('buildStart');
  expect(metadata(await run.call('load', '\0adk-recipes-python'))).toMatchObject({
    available: true,
    localWheels: [{ name: 'galaxie', file: 'galaxie.whl' }],
  });
  await run.call('generateBundle');
  expect(run.emitted.map((asset) => asset.fileName)).toEqual([
    'python/wheels/adk.whl',
    'python/wheels/galaxie.whl',
    'python/runtime/pyodide.mjs',
    'python/agent/example.py',
  ]);
});

test('Python build omits missing prerequisites and rejects a changed wheel', async () => {
  fixture.files.delete(join(cache, 'adk.whl'));
  const run = harness(pythonAssets(cache));
  await run.call('configResolved', { command: 'build' });
  await run.call('buildStart');
  expect(metadata(await run.call('load', '\0adk-recipes-python'))).toMatchObject({
    available: false,
    bytes: 0,
  });
  await run.call('generateBundle');
  expect(run.emitted).toEqual([]);
  fixture.files.set(join(cache, 'adk.whl'), 'abd');
  await expect(run.call('buildStart')).rejects.toThrow('The Python wheel inventory is invalid.');
});

test('Python build emits both recipe packages and leaves lint tests out of hosted assets', async () => {
  fixture.pythonFiles = [
    'llm_auditor/__init__.py',
    'llm_auditor/agent.py',
    'llm_auditor/prompts.py',
    'loan/__init__.py',
    'loan/agent.py',
    'loan/prompts.py',
    'tests/test_lint.py',
  ];
  for (const file of fixture.pythonFiles)
    fixture.files.set(join(agent, file), '# Synthetic module\n');
  const run = harness(pythonAssets(cache));
  await run.call('configResolved', { command: 'build' });
  await run.call('buildStart');
  await run.call('generateBundle');
  expect(
    run.emitted
      .filter((asset) => asset.fileName.startsWith('python/agent/'))
      .map((asset) => asset.fileName),
  ).toEqual([
    'python/agent/llm_auditor/__init__.py',
    'python/agent/llm_auditor/agent.py',
    'python/agent/llm_auditor/prompts.py',
    'python/agent/loan/__init__.py',
    'python/agent/loan/agent.py',
    'python/agent/loan/prompts.py',
  ]);
});

test('Go build includes verified-helper metadata and glue, and omits the missing toolchain', async () => {
  const run = harness(goAssets());
  await run.call('configResolved', { command: 'build' });
  await run.call('buildStart');
  expect(fixture.goPackage).toBe('./recipes/financial/main');
  expect(metadata(await run.call('load', '\0adk-recipes-go'))).toEqual({
    available: true,
    wasm: { url: '/go/financial.wasm', bytes: 3, sha256: 'synthetic-wasm-digest' },
    glueUrl: '/go/wasm_exec.js',
  });
  await run.call('generateBundle');
  expect(run.emitted.map((asset) => asset.fileName)).toEqual([
    'go/financial.wasm',
    'go/wasm_exec.js',
  ]);
  fixture.goInstalled = false;
  await run.call('buildStart');
  expect(metadata(await run.call('load', '\0adk-recipes-go'))).toEqual({
    available: false,
    wasm: null,
    glueUrl: null,
  });
  await run.call('generateBundle');
  expect(fixture.builds).toBe(1);
  expect(run.emitted).toHaveLength(2);
});

test('serve mode never advertises or builds assets that only generateBundle can emit', async () => {
  for (const [plugin, id] of [
    [pythonAssets(cache), '\0adk-recipes-python'],
    [goAssets(), '\0adk-recipes-go'],
  ] as const) {
    const run = harness(plugin);
    await run.call('configResolved', { command: 'serve' });
    await run.call('buildStart');
    expect(metadata(await run.call('load', id))).toMatchObject({ available: false });
    await run.call('generateBundle');
    expect(run.emitted).toEqual([]);
  }
  expect(fixture.builds).toBe(0);
});
