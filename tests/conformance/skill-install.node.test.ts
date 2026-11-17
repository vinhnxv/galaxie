// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';
import { pythonAffected } from '../../scripts/ci-scope.js';
import { install } from '../../scripts/install-skill.js';

const source = fileURLToPath(new URL('../../skills/galaxie/', import.meta.url));
const skillVersion = /^version: (.+)$/m.exec(await readFile(join(source, 'SKILL.md'), 'utf8'))![1]!;
const [major, minor] = skillVersion.split('.').map(Number);
const mismatchVersion = `${major}.${minor! + 1}.0`;
const script = fileURLToPath(new URL('../../scripts/install-skill.ts', import.meta.url));

test('guidance Markdown stays Python-independent while the unknown installer path runs Python jobs', () => {
  expect(
    pythonAffected([
      'skills/galaxie/SKILL.md',
      'skills/galaxie/references/framework-langgraph-python.md',
    ]),
  ).toBe(false);
  expect(pythonAffected(['scripts/install-skill.ts'])).toBe(true);
});

async function app(version: string | undefined = skillVersion): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'galaxie-skill-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      dependencies: version === undefined ? {} : { '@galaxie-ai/core': version },
    }),
  );
  return directory;
}

async function tree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const info = await lstat(path);
      expect(info.isSymbolicLink(), path).toBe(false);
      if (info.isDirectory()) await visit(path, `${prefix}${name}/`);
      else files[`${prefix}${name}`] = (await readFile(path)).toString('base64');
    }
  }
  await visit(root, '');
  return files;
}

test('installs identical real files in both skill directories and preserves app instruction bytes', async () => {
  const directory = await app();
  const instructions = new Map([
    ['AGENTS.md', Buffer.from('Keep my instructions.\r\n')],
    ['CLAUDE.md', Buffer.from('@personal.md\n')],
    ['agents.md', Buffer.from('Case-insensitive instruction file.\n')],
  ]);
  // On a case-insensitive filesystem AGENTS.md and agents.md share one file.
  for (const [name, bytes] of instructions) await writeFile(join(directory, name), bytes);
  const before = new Map(
    await Promise.all(
      [...instructions.keys()].map(
        async (name) => [name, await readFile(join(directory, name))] as const,
      ),
    ),
  );
  install(directory);
  for (const name of instructions.keys())
    expect(await readFile(join(directory, name))).toEqual(before.get(name));
  const expected = Object.fromEntries(
    Object.entries(await tree(source)).filter(
      ([path]) => path === 'SKILL.md' || path.startsWith('references/'),
    ),
  );
  for (const parent of ['.agents', '.claude']) {
    const root = join(directory, parent, 'skills/galaxie');
    expect(await tree(root)).toEqual(expected);
    for (const path of Object.keys(expected))
      expect((await lstat(join(root, path))).mode & 0o777).toBe(0o644);
  }
  const installed = await tree(directory);
  install(directory);
  expect(await tree(directory)).toEqual(installed);
});

test.each([mismatchVersion, `^${skillVersion}`, 'workspace:*', 'missing'])(
  'refuses %s core without writing',
  async (version) => {
    const directory = await app(version === 'missing' ? undefined : version);
    if (version === 'missing') await writeFile(join(directory, 'package.json'), '{}');
    const before = await tree(directory);
    const result = spawnSync(process.execPath, [script, directory], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`skill=${skillVersion}`);
    expect(result.stderr).toContain('core=');
    expect(await tree(directory)).toEqual(before);
    expect(await readdir(directory)).toEqual(['package.json']);
  },
);

test('installed core takes precedence over the declared dependency and explicit override', async () => {
  const directory = await app(`^${skillVersion}`);
  const core = join(directory, 'node_modules/@galaxie-ai/core');
  await mkdir(core, { recursive: true });
  await writeFile(join(core, 'package.json'), JSON.stringify({ version: mismatchVersion }));
  const before = await tree(directory);
  expect(() => install(directory, { coreVersion: skillVersion })).toThrow(
    `core=${mismatchVersion}`,
  );
  expect(await tree(directory)).toEqual(before);
  await writeFile(join(core, 'package.json'), JSON.stringify({ version: skillVersion }));
  install(directory);
  expect(await readFile(join(directory, '.agents/skills/galaxie/SKILL.md'))).toEqual(
    await readFile(join(source, 'SKILL.md')),
  );
});

test('explicit core version supports a hoisted app with a dependency range', async () => {
  const directory = await app(`^${skillVersion}`);
  const result = spawnSync(process.execPath, [script, directory, '--core-version', skillVersion], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  expect(await tree(join(directory, '.agents/skills/galaxie'))).toEqual(
    await tree(join(directory, '.claude/skills/galaxie')),
  );
});

test('refuses differing contents before writing either destination and replaces only the selected skill', async () => {
  const directory = await app();
  await mkdir(join(directory, '.claude/skills/galaxie'), { recursive: true });
  await writeFile(join(directory, '.claude/skills/galaxie/old.md'), 'Old skill.');
  await mkdir(join(directory, '.claude/skills/other'), { recursive: true });
  await writeFile(join(directory, '.claude/skills/other/SKILL.md'), 'Other skill.');
  await writeFile(join(directory, 'AGENTS.md'), 'App instructions.');
  const before = await tree(directory);
  expect(() => install(directory)).toThrow('--replace-skill');
  expect(await tree(directory)).toEqual(before);
  const result = spawnSync(process.execPath, [script, directory, '--replace-skill'], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  expect(await readFile(join(directory, '.claude/skills/other/SKILL.md'), 'utf8')).toBe(
    'Other skill.',
  );
  expect(await readFile(join(directory, 'AGENTS.md'), 'utf8')).toBe('App instructions.');
  expect(await tree(join(directory, '.agents/skills/galaxie'))).toEqual(
    await tree(join(directory, '.claude/skills/galaxie')),
  );
  expect(await readdir(join(directory, '.claude/skills/galaxie'))).not.toContain('old.md');
});

test.each([
  '.agents',
  '.claude',
  '.claude/skills',
  '.claude/skills/galaxie',
  '.claude/skills/galaxie/SKILL.md',
])('refuses a symlink at %s even with replacement', async (path) => {
  const directory = await app();
  const outside = await app();
  const parts = path.split('/');
  await mkdir(join(directory, ...parts.slice(0, -1)), { recursive: true });
  await symlink(outside, join(directory, path));
  const before = await tree(outside);
  expect(() => install(directory, { replaceSkill: true })).toThrow(/symlink/i);
  expect(await tree(outside)).toEqual(before);
  if (!path.startsWith('.agents')) expect(await readdir(directory)).not.toContain('.agents');
});

test.each(
  [
    [],
    ['--unknown'],
    ['--core-version'],
    ['--core-version', '^0.1.0'],
    ['--replace-skill', '--replace-skill'],
  ].map((args) => ({ args })),
)('rejects invalid CLI arguments $args without writes', async ({ args }) => {
  const directory = await app();
  const result = spawnSync(
    process.execPath,
    [script, ...(args.length === 0 ? [] : [directory, ...args])],
    { encoding: 'utf8' },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('Usage:');
  expect(await readdir(directory)).toEqual(['package.json']);
});

test('skill version follows core, instructs comparison and documents the absent release', async () => {
  const skill = await readFile(join(source, 'SKILL.md'), 'utf8');
  const core = JSON.parse(
    await readFile(new URL('../../packages/core/package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  expect(/^version: (.+)$/m.exec(skill)?.[1]).toBe(core.version);
  expect(skill).toContain("compare this skill's `version`");
  expect(skill).toContain('Stop on a mismatch');
  const readme = await readFile(join(source, 'README.md'), 'utf8');
  expect(readme).toContain(`\`v${core.version}\` does not exist until the maintainer creates it.`);
  expect(readme).toContain('22.18');
});

test('a failed write leaves no half skill and no staging directory', async () => {
  const directory = await app();
  await mkdir(join(directory, '.claude'), { recursive: true });
  await chmod(join(directory, '.claude'), 0o555);
  onTestFinished(() => chmod(join(directory, '.claude'), 0o755));
  if (process.getuid?.() === 0) return;
  expect(() => install(directory)).toThrow();
  await expect(lstat(join(directory, '.agents/skills/galaxie'))).rejects.toThrow();
  expect(await readdir(join(directory, '.agents/skills'))).toEqual([]);
});
