// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { compose, LayerCollisionError, SelectionError } from '../src/compose.js';
import { type Layer, LayerManifestError, loadLayers } from '../src/layers.js';

const bytes = (value: string): Uint8Array => Buffer.from(value);
function layer(
  id: string,
  type: Layer['manifest']['type'],
  files: Record<string, string> = {},
): Layer {
  return {
    manifest: {
      schema: 1,
      id,
      type,
      package: {},
      ...(type === 'kind' ? { frameworks: ['langgraph-js'] } : {}),
    },
    files: new Map(Object.entries(files).map(([path, value]) => [path, bytes(value)])),
    workspaceFiles: new Map(),
  };
}
const options = {
  kind: 'browser-only',
  framework: 'langgraph-js',
  name: 'my-app',
  mode: 'project',
  packageManager: 'npm',
} as const;
const basic = (): Layer[] => [
  layer('base', 'base', {
    _gitignore: 'node_modules/\n',
    'tsconfig.json': '{"compilerOptions":{"types":["vite/client"]},"include":["src"]}\n',
  }),
  layer('browser-only', 'kind', { 'src/main.tsx': 'main\n' }),
  layer('langgraph-js', 'framework', { 'src/agent.ts': 'agent\n' }),
];

test('composition emits a fixed sorted project map offline with the name only in its manifest', () => {
  const layers = basic();
  layers[0]!.manifest.package = {
    version: '0.0.0',
    private: true,
    license: 'Apache-2.0',
    dependencies: { zod: '4.6.7', react: '19.3.1' },
  };
  const first = compose(layers, options);
  const second = compose(layers, options);
  expect(first).toEqual(second);
  expect([...first.files.keys()]).toEqual([
    '.gitignore',
    'package.json',
    'src/agent.ts',
    'src/main.tsx',
    'tsconfig.json',
  ]);
  expect(JSON.parse(Buffer.from(first.files.get('package.json')!.bytes).toString())).toEqual({
    name: 'my-app',
    version: '0.0.0',
    private: true,
    license: 'Apache-2.0',
    dependencies: { react: '19.3.1', zod: '4.6.7' },
  });
  expect(
    Object.keys(JSON.parse(Buffer.from(first.files.get('package.json')!.bytes).toString())),
  ).toEqual(['name', 'version', 'private', 'license', 'dependencies']);
  for (const [path, file] of first.files) {
    expect(file.mode).toBe(0o644);
    expect(Buffer.from(file.bytes).toString()).not.toContain('\r\n');
    if (path !== 'package.json') expect(Buffer.from(file.bytes).toString()).not.toContain('my-app');
  }
  expect(first.report.layers).toEqual(['base', 'browser-only', 'langgraph-js']);
});

test('a duplicate output names the path and both layers before returning any files', () => {
  const layers = basic();
  layers[2]!.files = new Map([['src/main.tsx', bytes('different\n')]]);
  expect(() => compose(layers, options)).toThrow(LayerCollisionError);
  expect(() => compose(layers, options)).toThrow('src/main.tsx');
  expect(() => compose(layers, options)).toThrow('browser-only');
  expect(() => compose(layers, options)).toThrow('langgraph-js');
});

test('unknown selections and unsupported pairings list the valid choices', () => {
  expect(() => compose(basic(), { ...options, kind: 'unknown' })).toThrow(SelectionError);
  expect(() => compose(basic(), { ...options, kind: 'unknown' })).toThrow('browser-only');
  expect(() => compose(basic(), { ...options, framework: 'unknown' })).toThrow('langgraph-js');
  const layers = [...basic(), layer('adk-js', 'framework')];
  expect(() => compose(layers, { ...options, framework: 'adk-js' })).toThrow(
    'Valid frameworks: langgraph-js',
  );
  expect(() => compose(layers, options)).not.toThrow();
});

test('workspace mode emits the workspace files and remaps repository source paths', () => {
  const layers = basic();
  layers[1]!.workspaceFiles = new Map([['test/app.test.ts', bytes('test\n')]]);
  layers[1]!.manifest.workspace = {
    paths: { '@galaxie-ai/core': ['packages/core/src/index.ts'] },
    include: ['src', 'vite.config.ts'],
  };
  const result = compose(layers, { ...options, mode: 'workspace-test', workspaceRoot: '/repo' });
  expect(
    JSON.parse(Buffer.from(result.files.get('tsconfig.workspace.json')!.bytes).toString()),
  ).toEqual({
    extends: './tsconfig.json',
    compilerOptions: { paths: { '@galaxie-ai/core': ['../../../../core/src/index.ts'] } },
    include: ['src', 'vite.config.ts'],
  });
  expect(result.files.has('test/app.test.ts')).toBe(true);
  const project = compose(layers, options);
  expect(project.files.has('test/app.test.ts')).toBe(false);
  expect(project.files.has('tsconfig.workspace.json')).toBe(false);
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'galaxie-layers-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const [directory, id, type] of [
    ['base', 'base', 'base'],
    ['kinds/browser-only', 'browser-only', 'kind'],
    ['frameworks/langgraph-js', 'langgraph-js', 'framework'],
  ] as const) {
    await mkdir(join(root, directory, 'files'), { recursive: true });
    await writeFile(
      join(root, directory, 'layer.json'),
      JSON.stringify({
        schema: 1,
        id,
        type,
        package: {},
        ...(type === 'kind' ? { frameworks: ['langgraph-js'] } : {}),
      }),
    );
  }
  await writeFile(join(root, 'base/files/_gitignore'), 'node_modules/\n');
  return root;
}

test('the loader validates real manifests and reads LF bytes', async () => {
  const root = await fixture();
  const loaded = await loadLayers(root);
  expect(loaded.map((item) => item.manifest.id)).toEqual(['base', 'browser-only', 'langgraph-js']);
  expect(Buffer.from(loaded[0]!.files.get('_gitignore')!).toString()).toBe('node_modules/\n');
  expect(compose(loaded, options).files.has('.gitignore')).toBe(true);
});

test.each([
  { schema: 2 },
  { id: 'wrong' },
  { type: 'unknown' },
  { unexpected: true },
  { package: [] },
  { frameworks: ['unknown'], type: 'base' },
  { workspace: { extra: true } },
  { json: { '../outside.json': {} } },
])('invalid manifests fail with a fixed reason and valid values: %j', async (patch) => {
  const root = await fixture();
  await writeFile(
    join(root, 'base/layer.json'),
    JSON.stringify({ schema: 1, id: 'base', type: 'base', package: {}, ...patch }),
  );
  await expect(loadLayers(root)).rejects.toBeInstanceOf(LayerManifestError);
  await expect(loadLayers(root)).rejects.toThrow('Valid');
});

test('the loader rejects CRLF and symlinks after accepting the same real LF file', async () => {
  const root = await fixture();
  expect(await loadLayers(root)).toHaveLength(3);
  await writeFile(join(root, 'base/files/a.ts'), 'line\r\n');
  await expect(loadLayers(root)).rejects.toThrow('LF');
  await writeFile(join(root, 'base/files/a.ts'), 'line\n');
  expect(await loadLayers(root)).toHaveLength(3);
  await symlink(join(root, 'base/files/a.ts'), join(root, 'base/files/link.ts'));
  await expect(loadLayers(root)).rejects.toThrow('symlink');
  expect(await readFile(join(root, 'base/files/a.ts'), 'utf8')).toBe('line\n');
});

test.each(['../x', '/etc/x', 'a\\b', 'a//b', '.git/config', 'a\0b'])(
  'the composer rejects invalid emitted paths: %j',
  (path) => {
    const layers = basic();
    layers[2]!.files = new Map([[path, bytes('bad')]]);
    expect(() => compose(layers, options)).toThrow('path');
    expect(() => compose(basic(), options)).not.toThrow();
  },
);

test('JSON patches merge only into declared JSON seeds and preserve conflict ownership', () => {
  const layers = basic();
  layers[1]!.manifest.json = {
    'tsconfig.json': { compilerOptions: { types: ['node', 'vite/client'] }, include: ['server'] },
  };
  expect(
    JSON.parse(Buffer.from(compose(layers, options).files.get('tsconfig.json')!.bytes).toString()),
  ).toEqual({ compilerOptions: { types: ['vite/client', 'node'] }, include: ['src', 'server'] });
  layers[2]!.manifest.json = {
    'tsconfig.json': { compilerOptions: { types: ['node'], strict: false } },
  };
  layers[1]!.manifest.json['tsconfig.json']!['compilerOptions'] = { types: ['node'], strict: true };
  expect(() => compose(layers, options)).toThrow(
    'tsconfig.json.compilerOptions.strict between layers browser-only and langgraph-js',
  );
  layers[2]!.manifest.json = { 'absent.json': {} };
  expect(() => compose(layers, options)).toThrow('existing JSON output');
});

test('the name does not enter verbatim files and reserved manifest paths collide', () => {
  const layers = basic();
  layers[2]!.files = new Map([['src/agent.ts', bytes('project-name\n')]]);
  expect(
    Buffer.from(
      compose(layers, { ...options, name: 'another-name' }).files.get('src/agent.ts')!.bytes,
    ).toString(),
  ).toBe('project-name\n');
  layers[2]!.files = new Map([['package.json', bytes('{}\n')]]);
  expect(() => compose(layers, options)).toThrow(LayerCollisionError);
});

test('the loader rejects a reserved git path and a backslash path while accepting regular names', async () => {
  const root = await fixture();
  await writeFile(join(root, 'base/files/valid.ts'), 'valid\n');
  expect(await loadLayers(root)).toHaveLength(3);
  await writeFile(join(root, 'base/files/a\\b'), 'bad\n');
  await expect(loadLayers(root)).rejects.toThrow('path');
  await rm(join(root, 'base/files/a\\b'));
  expect(await loadLayers(root)).toHaveLength(3);
  await mkdir(join(root, 'base/files/.git'));
  await writeFile(join(root, 'base/files/.git/config'), 'bad\n');
  await expect(loadLayers(root)).rejects.toThrow('path');
});

test('malformed JSON and invalid manifest values never leak the document text', async () => {
  const root = await fixture();
  const path = join(root, 'base/layer.json');
  const original = await readFile(path, 'utf8');
  for (const source of [
    '{"unexpected":"document-value-canary",',
    '{"schema":1,"id":"base","type":"document-value-canary","package":{}}',
  ]) {
    await writeFile(path, source);
    let error: unknown;
    try {
      await loadLayers(root);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LayerManifestError);
    expect((error as Error).message).toContain('Valid schema: 1');
    expect((error as Error).message).not.toContain('document-value-canary');
    await writeFile(path, original);
    expect(await loadLayers(root)).toHaveLength(3);
  }
});

test('npm tarball composition rewrites direct dependencies and overrides, and other managers refuse it', () => {
  const layers = basic();
  layers[0]!.manifest.package = { dependencies: { '@galaxie-ai/core': '^0.1.0', react: '19.3.1' } };
  const tarballs = new Map([
    ['@galaxie-ai/ui-protocol', '/packed/galaxie-ai-ui-protocol-0.1.0.tgz'],
    ['@galaxie-ai/core', '/packed/galaxie-ai-core-0.1.0.tgz'],
    ['@galaxie-ai/adapter-kit', '/packed/galaxie-ai-adapter-kit-0.1.0.tgz'],
    ['@galaxie-ai/adapter-langgraph', '/packed/galaxie-ai-adapter-langgraph-0.1.0.tgz'],
    ['@galaxie-ai/models', '/packed/galaxie-ai-models-0.1.0.tgz'],
    ['@galaxie-ai/storage-indexeddb', '/packed/galaxie-ai-storage-indexeddb-0.1.0.tgz'],
    ['@galaxie-ai/react', '/packed/galaxie-ai-react-0.1.0.tgz'],
  ]);
  const result = compose(layers, { ...options, tarballs });
  const manifest = JSON.parse(Buffer.from(result.files.get('package.json')!.bytes).toString());
  expect(manifest.dependencies).toEqual({
    '@galaxie-ai/core': 'file:/packed/galaxie-ai-core-0.1.0.tgz',
    react: '19.3.1',
  });
  expect(manifest.overrides).toEqual({
    '@galaxie-ai/ui-protocol': 'file:/packed/galaxie-ai-ui-protocol-0.1.0.tgz',
    '@galaxie-ai/core': 'file:/packed/galaxie-ai-core-0.1.0.tgz',
    '@galaxie-ai/adapter-kit': 'file:/packed/galaxie-ai-adapter-kit-0.1.0.tgz',
    '@galaxie-ai/adapter-langgraph': 'file:/packed/galaxie-ai-adapter-langgraph-0.1.0.tgz',
    '@galaxie-ai/models': 'file:/packed/galaxie-ai-models-0.1.0.tgz',
    '@galaxie-ai/storage-indexeddb': 'file:/packed/galaxie-ai-storage-indexeddb-0.1.0.tgz',
    '@galaxie-ai/react': 'file:/packed/galaxie-ai-react-0.1.0.tgz',
  });
  for (const packageManager of ['pnpm', 'yarn'] as const)
    expect(() => compose(layers, { ...options, tarballs, packageManager })).toThrow(
      'Tarball mode supports npm only',
    );
});
