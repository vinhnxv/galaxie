// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../..', import.meta.url));

function createPackSource(root: string, directory: string): string {
  const source = join(root, 'packages/create');
  cpSync(directory, source, {
    recursive: true,
    filter: (path) =>
      !['node_modules', '.cache', 'dist', 'templates', 'skills'].includes(
        relative(directory, path).split(sep)[0] as string,
      ),
  });
  for (const path of [
    'scripts/prepare-create.ts',
    'tsconfig.base.json',
    'templates',
    'skills/galaxie',
  ]) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repo, path), target, { recursive: true });
  }
  symlinkSync(join(directory, 'node_modules'), join(source, 'node_modules'), 'dir');
  return source;
}

export function packPackage(directory: string, destination: string, ignoreScripts = false): string {
  const temporary =
    directory === join(repo, 'packages/create')
      ? mkdtempSync(join(tmpdir(), 'galaxie-create-pack-source-'))
      : undefined;
  try {
    execFileSync(
      'pnpm',
      [
        'pack',
        ...(ignoreScripts ? ['--config.ignore-scripts=true'] : []),
        '--pack-destination',
        destination,
      ],
      {
        cwd: temporary === undefined ? directory : createPackSource(temporary, directory),
        encoding: 'utf8',
        timeout: 300_000,
      },
    );
  } finally {
    if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
  }
  const filenames = readdirSync(destination).filter((name) => name.endsWith('.tgz'));
  if (filenames.length !== 1) throw new Error(`Expected one tarball in ${destination}.`);
  return join(destination, filenames[0] as string);
}
