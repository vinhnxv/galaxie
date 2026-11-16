// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { compose } from '../../packages/create/src/compose.js';
import { type Layer, loadLayers } from '../../packages/create/src/layers.js';
import type { JsonObject } from '../../packages/create/src/merge.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const templates = fileURLToPath(new URL('../../templates/', import.meta.url));
const options = {
  framework: 'langgraph-js',
  name: 'example-app',
  mode: 'project',
  packageManager: 'npm',
} as const;
async function manifest(path: string): Promise<JsonObject> {
  return JSON.parse(
    await readFile(new URL('../../' + path + '/package.json', import.meta.url), 'utf8'),
  ) as JsonObject;
}

function mismatchedPins(layers: readonly Layer[], pins: JsonObject): string[] {
  const problems: string[] = [];
  for (const layer of layers)
    for (const section of ['dependencies', 'devDependencies']) {
      for (const [name, version] of Object.entries(
        (layer.manifest.package[section] ?? {}) as JsonObject,
      )) {
        if (name.startsWith('@galaxie-ai/')) continue;
        if (
          typeof version !== 'string' ||
          !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ||
          pins[name] !== version
        )
          problems.push(`${layer.manifest.id}.${section}.${name}`);
      }
    }
  return problems;
}

test('layer third-party pins equal create tooling and share React with the renderer', async () => {
  const layers = await loadLayers(templates);
  const create = await manifest('packages/create');
  const renderer = await manifest('packages/react');
  const pins = create['devDependencies'] as JsonObject;
  expect(mismatchedPins(layers, pins)).toEqual([]);
  expect(mismatchedPins(layers, { ...pins, zod: '0.0.0' })).toEqual([
    'langgraph-js.dependencies.zod',
  ]);
  expect(mismatchedPins(layers, { ...pins, react: '*' })).toEqual(['base.dependencies.react']);
  const rendererPins = renderer['devDependencies'] as JsonObject;
  for (const name of ['react', '@types/react']) expect(pins[name], name).toBe(rendererPins[name]);
  expect(create).toMatchObject({
    name: '@galaxie-ai/create',
    private: true,
    version: '0.0.0',
    type: 'module',
    license: 'Apache-2.0',
    engines: { node: '>=22.22.2' },
    bin: { create: 'dist/cli.js' },
  });
  expect(create['dependencies']).toBeUndefined();
});

test('both kinds share agent bytes and preserve the original CSP source hashes', async () => {
  const layers = await loadLayers(templates);
  const browser = compose(layers, { ...options, kind: 'browser-only' });
  const gateway = compose(layers, { ...options, kind: 'gateway' });
  expect(browser.files.get('src/agent.ts')?.bytes).toEqual(
    gateway.files.get('src/agent.ts')?.bytes,
  );
  for (const [project, expected] of [
    [browser, '05dbd8eee1c3a95ea1a4b223eb17fd99a7148a9bdebc560f4f670cd5133ebf79'],
    [gateway, '6ca810a0c86df49ee16df1e6d7e3f958e441f123affa72cd6b31377bd75e827f'],
  ] as const) {
    const source = project.files.get('src/csp.ts');
    expect(source).toBeDefined();
    expect(
      createHash('sha256')
        .update(source?.bytes ?? new Uint8Array())
        .digest('hex'),
    ).toBe(expected);
    expect(project.files.has('.gitignore')).toBe(true);
    expect(project.files.has('tsconfig.workspace.json')).toBe(false);
    expect([...project.files.keys()].some((path) => path.startsWith('test/'))).toBe(false);
    const pkg = JSON.parse(
      Buffer.from(project.files.get('package.json')?.bytes ?? []).toString(),
    ) as JsonObject;
    expect(JSON.stringify(pkg)).not.toContain('workspace:');
    expect(Object.keys(pkg)).toEqual([
      'name',
      'version',
      'private',
      'description',
      'license',
      'type',
      'engines',
      'scripts',
      'dependencies',
      'devDependencies',
    ]);
    expect(Object.keys(pkg['dependencies'] as JsonObject)).toEqual(
      Object.keys(pkg['dependencies'] as JsonObject).sort(),
    );
  }
  const common = [
    '.gitignore',
    'README.md',
    'check/baseline.check.ts',
    'check/tsconfig.json',
    'index.html',
    'package.json',
    'src/agent.ts',
    'src/app.tsx',
    'src/csp.ts',
    'src/main.tsx',
    'src/runtime.ts',
    'tsconfig.json',
    'vite.config.ts',
  ];
  expect([...browser.files.keys()]).toEqual(
    [...common, 'src/model-state.ts', 'src/webllm.ts', 'src/webllm-worker.ts'].sort(),
  );
  expect([...gateway.files.keys()]).toEqual(
    [
      ...common,
      'public/favicon.svg',
      'server/dev.ts',
      'server/gateway.ts',
      'server/mock-upstream.ts',
      'server/plugin.ts',
      'server/serve.ts',
      'server/tsconfig.json',
      'src/gateway-state.ts',
      'src/model-fetch.ts',
      'src/session.ts',
    ].sort(),
  );
  const workspace = compose(layers, {
    ...options,
    kind: 'browser-only',
    mode: 'workspace-test',
    workspaceRoot: repo,
  });
  expect(workspace.files.has('test/app.test.ts')).toBe(true);
});
