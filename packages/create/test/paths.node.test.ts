// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';
import {
  ProjectPathError,
  projectName,
  validateOutputPath,
  validateProjectName,
  validateTarget,
} from '../src/paths.js';

test.each(['../x', 'a/../x', 'a/./x', '/etc/x', 'a\\b', 'a//b', '.git/config', 'a\0b', 'C:/x'])(
  'rejects an unsafe output path %j',
  (path) => {
    expect(() => validateOutputPath(path)).toThrow(ProjectPathError);
    expect(validateOutputPath('src/main.tsx')).toBe('src/main.tsx');
  },
);
test.each(['Uppercase', '.hidden', 'spaces here', 'node_modules', 'favicon.ico', 'x'.repeat(215)])(
  'rejects invalid npm names %j',
  (name) => {
    expect(() => validateProjectName(name)).toThrow('lowercase npm package name');
    expect(validateProjectName('my-app_1')).toBe('my-app_1');
  },
);
test('target checking rejects root, NUL and traversal while deriving a valid name', () => {
  for (const target of ['/', '../outside', 'a/../outside', 'a\0b'])
    expect(() => validateTarget(target)).toThrow(ProjectPathError);
  expect(projectName('nested/my-app')).toBe('my-app');
});

function assetFixture(
  path: 'templates' | 'skills/galaxie',
  layout = 'checkout',
): {
  packed: string;
  repository: string;
  run: () => { status: number | null; output: string };
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'galaxie-create-assets-')));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, layout === 'checkout' ? 'packages/create' : 'isolated/package');
  const module = join(directory, layout === 'checkout' ? 'src/paths.ts' : 'dist/paths.ts');
  mkdirSync(dirname(module), { recursive: true });
  copyFileSync(fileURLToPath(new URL('../src/paths.ts', import.meta.url)), module);
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  const packed = join(directory, path);
  const repository = join(root, path);
  mkdirSync(join(packed, 'nested'), { recursive: true });
  writeFileSync(join(packed, 'nested/content.txt'), 'original\n');
  if (layout === 'checkout') cpSync(packed, repository, { recursive: true });
  return {
    packed,
    repository,
    run: () => {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          'const { assetRoot } = await import(process.argv[1]); try { process.stdout.write(assetRoot(process.argv[2])); } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }',
          pathToFileURL(module).href,
          path,
        ],
        { encoding: 'utf8' },
      );
      return { status: result.status, output: result.stdout + result.stderr };
    },
  };
}

test.each(['templates', 'skills/galaxie'] as const)(
  'asset resolution uses fresh checkout copies, repository fallback and packed-only %s',
  (path) => {
    const checkout = assetFixture(path);
    expect(checkout.run()).toEqual({ status: 0, output: checkout.packed });
    rmSync(checkout.packed, { recursive: true });
    expect(checkout.run()).toEqual({ status: 0, output: checkout.repository });
    const packed = assetFixture(path, 'packed');
    mkdirSync(join(packed.repository, 'nested'), { recursive: true });
    writeFileSync(join(packed.repository, 'nested/content.txt'), 'unrelated nearby repository\n');
    expect(packed.run()).toEqual({ status: 0, output: packed.packed });
  },
);

test.each(['templates', 'skills/galaxie'] as const)(
  'stale packaged %s cannot shadow checkout assets',
  (path) => {
    const fixture = assetFixture(path);
    for (const change of ['edited', 'extra', 'missing']) {
      const file = join(fixture.packed, 'nested/content.txt');
      if (change === 'edited') writeFileSync(file, 'stale\n');
      if (change === 'extra') writeFileSync(join(fixture.packed, 'extra.txt'), 'extra\n');
      if (change === 'missing') rmSync(file);
      const result = fixture.run();
      expect(result.status, change).toBe(1);
      expect(result.output, change).toContain(`Packaged ${path} assets differ from the repository`);
      expect(result.output, change).toContain('pnpm --filter @galaxie-ai/create run clean:pack');
      rmSync(fixture.packed, { recursive: true });
      cpSync(fixture.repository, fixture.packed, { recursive: true });
      expect(fixture.run()).toEqual({ status: 0, output: fixture.packed });
    }
  },
);
