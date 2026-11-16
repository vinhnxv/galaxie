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
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';
import type { ProjectFile } from '../src/compose.js';
import { loadGuidanceSource, renderGuidance } from '../src/guidance.js';
import { ProjectWriteError, planWrite, writeProject } from '../src/write.js';

const files = (values: Record<string, string>): Map<string, ProjectFile> =>
  new Map(
    Object.entries(values).map(([path, value]) => [
      path,
      { bytes: Buffer.from(value), mode: 0o644 },
    ]),
  );
async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'galaxie-write-'));
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('exclusive creation uses fixed modes and preserves case-insensitive instruction files', async () => {
  const root = await scratch();
  await writeFile(join(root, 'AGENTS.md'), 'host-owned\n');
  await writeFile(join(root, 'claude.md'), 'also-host-owned\n');
  const guidance = renderGuidance(
    await loadGuidanceSource(fileURLToPath(new URL('../../../skills/galaxie', import.meta.url))),
    { kind: 'browser-only', framework: 'langgraph-js' },
  );
  const plan = await planWrite(
    new Map([
      ...[...guidance].map(([path, bytes]) => [path, { bytes, mode: 0o644 }] as const),
      ...files({
        'package.json': '{}\n',
        'src/main.ts': 'main\n',
      }),
    ]),
    root,
  );
  expect(plan.conflicts).toEqual([]);
  expect(plan.skipped).toEqual(['AGENTS.md', 'CLAUDE.md']);
  await writeProject(plan);
  expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('host-owned\n');
  expect(await readFile(join(root, 'claude.md'), 'utf8')).toBe('also-host-owned\n');
  expect(await readFile(join(root, 'src/main.ts'), 'utf8')).toBe('main\n');
  expect((await stat(join(root, 'src/main.ts'))).mode & 0o777).toBe(0o644);
  expect((await stat(join(root, 'src'))).mode & 0o777).toBe(0o755);
  for (const [path, bytes] of guidance) {
    if (path === 'AGENTS.md' || path === 'CLAUDE.md') continue;
    expect(await readFile(join(root, path))).toEqual(Buffer.from(bytes));
    expect((await lstat(join(root, path))).isSymbolicLink()).toBe(false);
  }
});

test('all ordinary existing paths are listed and no output is written', async () => {
  const root = await scratch();
  await writeFile(join(root, 'package.json'), 'existing');
  await writeFile(join(root, 'README.md'), 'existing');
  const plan = await planWrite(
    files({ 'package.json': 'new', 'README.md': 'new', 'new.ts': 'new' }),
    root,
  );
  expect(plan.conflicts).toEqual(['README.md', 'package.json']);
  await expect(writeProject(plan)).rejects.toThrow(ProjectWriteError);
  expect(await readdir(root)).toEqual(['README.md', 'package.json']);
  expect(await readFile(join(root, 'package.json'), 'utf8')).toBe('existing');
});

test('target files and symlinks are refused; a normal absent target is accepted', async () => {
  const root = await scratch();
  await writeFile(join(root, 'file'), 'existing');
  await expect(planWrite(files({ 'a.ts': 'new' }), join(root, 'file'))).rejects.toThrow(
    'directory',
  );
  await mkdir(join(root, 'real'));
  await symlink(join(root, 'real'), join(root, 'link'));
  await expect(planWrite(files({ 'a.ts': 'new' }), join(root, 'link'))).rejects.toThrow('symlink');
  await expect(planWrite(files({ 'a.ts': 'new' }), join(root, 'link', 'new-app'))).rejects.toThrow(
    'symlink',
  );
  await writeProject(await planWrite(files({ 'a.ts': 'new' }), join(root, 'new-app')));
  expect(await readFile(join(root, 'new-app/a.ts'), 'utf8')).toBe('new');
});

test('output symlink parents and replacement between plan and write cannot be followed', async () => {
  const root = await scratch();
  const outside = await scratch();
  await symlink(outside, join(root, 'src'));
  await expect(planWrite(files({ 'src/main.ts': 'new' }), root)).rejects.toThrow('symlink');
  await rm(join(root, 'src'));
  await mkdir(join(root, 'src'));
  const plan = await planWrite(files({ 'src/main.ts': 'new' }), root);
  await rm(join(root, 'src'), { recursive: true });
  await symlink(outside, join(root, 'src'));
  await expect(writeProject(plan)).rejects.toThrow('symlink');
  expect(await readdir(outside)).toEqual([]);
});

test('a symlinked ancestor above the trusted root is canonicalized', async () => {
  const root = await scratch();
  const actual = await scratch();
  await mkdir(join(actual, 'existing'));
  await symlink(actual, join(root, 'alias'));
  const target = join(root, 'alias/existing/new-app');
  const plan = await planWrite(files({ 'a.ts': 'new' }), target);
  expect(plan.trustedRoot).toBe(await realpath(join(actual, 'existing')));
  await writeProject(plan);
  expect(await readFile(join(actual, 'existing/new-app/a.ts'), 'utf8')).toBe('new');
});

test('a concurrent existing file is never replaced and failed writes remove only created files', async () => {
  const root = await scratch();
  const plan = await planWrite(files({ 'a.ts': 'created', 'z.ts': 'new' }), root);
  await writeFile(join(root, 'z.ts'), 'concurrent');
  await expect(writeProject(plan)).rejects.toThrow(ProjectWriteError);
  expect(await readFile(join(root, 'z.ts'), 'utf8')).toBe('concurrent');
  await expect(lstat(join(root, 'a.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a symlink in the middle of an existing target path is refused (base-relative walk)', async () => {
  const root = await scratch();
  const outside = await scratch();
  await mkdir(join(outside, 'sub'));
  await symlink(outside, join(root, 'link'));
  await expect(
    planWrite(files({ 'a.ts': 'new' }), join(root, 'link', 'sub', 'proj'), root),
  ).rejects.toThrow('symlink');
  // Positive control: the same shape without the link is accepted and writes inside the base.
  await mkdir(join(root, 'real', 'sub'), { recursive: true });
  await writeProject(
    await planWrite(files({ 'a.ts': 'new' }), join(root, 'real', 'sub', 'proj'), root),
  );
  expect(await readFile(join(root, 'real/sub/proj/a.ts'), 'utf8')).toBe('new');
  await expect(lstat(join(outside, 'sub', 'proj'))).rejects.toThrow();
});
