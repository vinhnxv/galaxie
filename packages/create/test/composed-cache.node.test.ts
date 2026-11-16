// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';
import { compose, type ProjectFile } from '../src/compose.js';
import { loadLayers } from '../src/layers.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const cache = join(repo, 'packages/create/.cache');
const instruction = 'Run pnpm run compose:create to refresh the composed cache.';

async function assertCache(
  directory: string,
  expected: ReadonlyMap<string, ProjectFile>,
): Promise<void> {
  const actual = new Set<string>();
  const walk = async (directory: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        prefix === '' &&
        entry.isDirectory() &&
        (['node_modules', 'dist', '.server'].includes(entry.name) ||
          /^\.(?:reload|browser)-check-/.test(entry.name))
      )
        continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        if (![...expected.keys()].some((file) => file.startsWith(path + '/')))
          throw new Error(instruction);
        await walk(join(directory, entry.name), path + '/');
      } else if (entry.isFile()) {
        actual.add(path);
        const file = expected.get(path);
        if (
          file === undefined ||
          !Buffer.from(file.bytes).equals(await readFile(join(directory, entry.name)))
        )
          throw new Error(instruction);
      } else throw new Error(instruction);
    }
  };
  try {
    await walk(directory);
    if (actual.size !== expected.size || [...expected.keys()].some((path) => !actual.has(path)))
      throw new Error(instruction);
  } catch {
    throw new Error(instruction);
  }
}

test.each(
  ['browser-only', 'gateway'].flatMap((kind) =>
    ['langgraph-js', 'adk-js', ...(kind === 'browser-only' ? ['adk-go'] : [])].map((framework) => ({
      kind,
      framework,
    })),
  ),
)(
  '$kind-$framework composed cache exactly matches the current layers',
  async ({ kind, framework }) => {
    const directory = join(cache, 'composed', kind + '-' + framework);
    try {
      await lstat(directory);
    } catch {
      throw new Error(instruction);
    }
    const layers = await loadLayers(join(repo, 'templates'));
    const { files } = compose(layers, {
      kind,
      framework,
      name: kind + '-' + framework,
      mode: 'workspace-test',
      packageManager: 'npm',
      workspaceRoot: repo,
    });
    expect([...files.keys()].filter((path) => /\.test\.ts$/.test(path))).toHaveLength(5);
    await assertCache(directory, files);
    if (framework === 'adk-go') {
      const installed = join(directory, 'node_modules/@galaxie-ai/starter-go');
      expect((await lstat(installed)).isSymbolicLink()).toBe(true);
      expect(await realpath(installed)).toBe(await realpath(join(repo, 'packages/starter-go')));
    }
  },
);

test('cache validation detects missing, edited, extra and unexpected paths while allowing test scratch', async () => {
  await mkdir(join(cache, 'cache-controls'), { recursive: true });
  const directory = await mkdtemp(join(cache, 'cache-controls/project-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const files = new Map([['expected.ts', { bytes: Buffer.from('expected\n'), mode: 0o644 }]]);
  await writeFile(join(directory, 'expected.ts'), 'expected\n');
  await assertCache(directory, files);
  await expect(assertCache(join(directory, 'missing'), files)).rejects.toThrow(instruction);
  for (const change of ['missing', 'edited', 'extra', 'empty-directory', 'unexpected-directory']) {
    if (change === 'missing') await rm(join(directory, 'expected.ts'));
    if (change === 'edited') await writeFile(join(directory, 'expected.ts'), 'changed\n');
    if (change === 'extra') await writeFile(join(directory, 'extra.ts'), 'extra\n');
    if (change.endsWith('directory')) await mkdir(join(directory, 'unexpected'));
    if (change === 'unexpected-directory')
      await writeFile(join(directory, 'unexpected/file'), 'extra\n');
    await expect(assertCache(directory, files)).rejects.toThrow(instruction);
    await rm(join(directory, 'extra.ts'), { force: true });
    await rm(join(directory, 'unexpected'), { recursive: true, force: true });
    await writeFile(join(directory, 'expected.ts'), 'expected\n');
    await assertCache(directory, files);
  }
  for (const ignored of [
    'node_modules',
    'dist',
    '.server',
    '.reload-check-123',
    '.browser-check-123',
  ]) {
    await mkdir(join(directory, ignored));
    await writeFile(join(directory, ignored, 'scratch'), 'scratch\n');
  }
  await assertCache(directory, files);
});
