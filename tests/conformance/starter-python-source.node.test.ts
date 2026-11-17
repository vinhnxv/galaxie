// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, type UserConfig } from 'vite';
import { afterAll, afterEach, expect, test } from 'vitest';
import { validSourcePath } from '../../packages/adapter-pyodide/src/bridge.js';
import type { StarterManifest } from '../../packages/starter-python/src/manifest.js';
import { buildStarterDistOnce, cleanStarterDist } from './support/starter-python.node.js';

const { pythonFramework } = (await import(
  new URL('../../templates/frameworks/langgraph-python/files/vite.framework.ts', import.meta.url)
    .href
)) as { pythonFramework(directory: string): UserConfig };

const temporary: string[] = [];
afterAll(cleanStarterDist);
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'galaxie-python-source-'));
  temporary.push(directory);
  await cp('templates/frameworks/langgraph-python/files/python', join(directory, 'python'), {
    recursive: true,
  });
  await mkdir(join(directory, 'node_modules/@galaxie-ai'), { recursive: true });
  const starter = await buildStarterDistOnce();
  await cp(starter.directory, join(directory, 'node_modules/@galaxie-ai/starter-python'), {
    recursive: true,
    dereference: false,
  });
  await symlink(
    resolve('packages/adapter-pyodide'),
    join(directory, 'node_modules/@galaxie-ai/adapter-pyodide'),
    'dir',
  );
  await symlink(
    resolve('packages/adapter-pyodide/node_modules/pyodide'),
    join(directory, 'node_modules/pyodide'),
    'dir',
  );
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(
    join(directory, 'entry.js'),
    "export { pythonBuild } from 'virtual:galaxie-python';",
  );
  return directory;
}
async function compile(directory: string): Promise<string> {
  const result = await build({
    ...pythonFramework(directory),
    configFile: false,
    root: directory,
    logLevel: 'silent',
    build: { write: false, lib: { entry: join(directory, 'entry.js'), formats: ['es'] } },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (output === undefined || !('output' in output))
    throw new Error('The build output is missing.');
  const chunk = output.output.find((item) => item.type === 'chunk');
  if (chunk?.type !== 'chunk') throw new Error('The build chunk is missing.');
  return chunk.code;
}
test('raw sources are rebuilt, including underscore paths and JSON inputs', async () => {
  const directory = await project();
  const initial = await compile(directory);
  const source = join(directory, 'python/agent/starter_agent/graph.py');
  await writeFile(source, (await readFile(source, 'utf8')) + '\n# An edited agent.\n');
  expect(await compile(directory)).not.toBe(initial);
  for (const name of ['_extra.py', 'settings.json']) {
    const before = await compile(directory);
    await writeFile(
      join(directory, 'python/agent', name),
      name.endsWith('.json') ? '{}' : '# Extra source.\n',
    );
    expect(await compile(directory)).not.toBe(before);
  }
});

test('editing an existing underscore-prefixed Python source changes sourceSha256', async () => {
  const directory = await project();
  const digest = (code: string): string => {
    const value = /sourceSha256:\s*"([a-f0-9]{64})"/.exec(code)?.[1];
    if (value === undefined) throw new Error('The compiled source hash is missing.');
    return value;
  };
  const before = digest(await compile(directory));
  const source = join(directory, 'python/agent/starter_agent/__init__.py');
  await writeFile(source, (await readFile(source, 'utf8')) + '\n# Edited existing source.\n');
  expect(digest(await compile(directory))).not.toBe(before);
});

test.each(['name', 'version', 'sha256'] as const)(
  'the adapter independently binds a packed wheel %s',
  async (field) => {
    const directory = await project();
    const dist = join(directory, 'node_modules/@galaxie-ai/starter-python/dist');
    const manifest = JSON.parse(
      await readFile(join(dist, 'manifest.json'), 'utf8'),
    ) as StarterManifest;
    const wheel = manifest.wheels[0];
    if (wheel === undefined) throw new Error('The wheel inventory is empty.');
    let replacement = { ...wheel, [field]: field === 'version' ? '0.0.0' : 'wrong-name' };
    if (field === 'sha256') {
      const path = join(dist, 'wheels', wheel.file);
      const bytes = await readFile(path);
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      await writeFile(path, bytes);
      // Keep the manifest consistent with a same-length edit to isolate the adapter hash pin.
      replacement = { ...wheel, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    await writeFile(
      join(dist, 'manifest.json'),
      JSON.stringify({ ...manifest, wheels: [replacement, ...manifest.wheels.slice(1)] }),
    );
    await expect(compile(directory)).rejects.toThrow(
      `The Python starter wheel could not be verified: ${wheel.file}.`,
    );
  },
);

test.each(['extra', 'missing'] as const)(
  'local wheel inventory refuses the %s entry',
  async (kind) => {
    const directory = await project();
    const dist = join(directory, 'node_modules/@galaxie-ai/starter-python/dist');
    const manifest = JSON.parse(
      await readFile(join(dist, 'manifest.json'), 'utf8'),
    ) as StarterManifest;
    const wheel = manifest.wheels.find((item) => item.name === 'galaxie');
    if (wheel === undefined) throw new Error('The local wheel inventory is empty.');
    const wheels =
      kind === 'extra'
        ? [...manifest.wheels, { ...wheel, name: 'extra', file: 'extra-1.0-py3-none-any.whl' }]
        : manifest.wheels.filter((item) => item !== wheel);
    if (kind === 'extra')
      await cp(join(dist, 'wheels', wheel.file), join(dist, 'wheels/extra-1.0-py3-none-any.whl'));
    await writeFile(join(dist, 'manifest.json'), JSON.stringify({ ...manifest, wheels }));
    await expect(compile(directory)).rejects.toThrow(
      'The Python starter wheel inventory is invalid.',
    );
  },
);
test.each(['bad-name.py', '.hidden.py', 'nested/bad name.json'])(
  'source-path validation agrees with the adapter for %s',
  async (name) => {
    expect(validSourcePath(name)).toBe(false);
    const directory = await project();
    const path = join(directory, 'python/agent', name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '# Invalid source.\n');
    await expect(compile(directory)).rejects.toThrow(name);
  },
);
test('symlinks are refused rather than followed', async () => {
  const directory = await project();
  await symlink(
    join(directory, 'python/agent/starter_agent/graph.py'),
    join(directory, 'python/agent/link.py'),
  );
  await expect(compile(directory)).rejects.toThrow('link.py');
});

test('hidden inputs affect source identity, while only the documented cache paths are ignored', async () => {
  const directory = await project();
  const initial = await compile(directory);
  const root = join(directory, 'python/agent');
  for (const name of ['.git', 'node_modules', '__pycache__']) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, 'ignored.py'), '# Ignored cache input.\n');
  }
  await writeFile(join(root, '.DS_Store'), 'ignored');
  expect(await compile(directory)).toBe(initial);
  await writeFile(join(root, '.metadata'), 'authored input');
  expect(await compile(directory)).not.toBe(initial);
});
