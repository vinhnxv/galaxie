// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterEach, expect, test } from 'vitest';
import { validSourcePath } from '../../packages/adapter-pyodide/src/bridge.js';
import { pythonFramework } from '../../templates/frameworks/langgraph-python/files/vite.framework.js';

const temporary: string[] = [];
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
  for (const name of ['starter-python', 'adapter-pyodide'])
    await symlink(
      resolve('packages', name),
      join(directory, 'node_modules/@galaxie-ai', name),
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
