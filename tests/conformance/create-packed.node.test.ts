// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { compose } from '../../packages/create/src/compose.js';
import { loadGuidanceSource, renderGuidance } from '../../packages/create/src/guidance.js';
import { loadLayers } from '../../packages/create/src/layers.js';
import { knownPackages, resolveTarballs } from '../../packages/create/src/packages.js';
import { packPackage } from './support/package-pack.node.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));

test('packed create runs help and scaffolds identical files with only Node on PATH', async () => {
  const root = mkdtempSync(join(tmpdir(), 'galaxie-create-packed-'));
  try {
    const tarballs = join(root, 'tarballs');
    const bin = join(root, 'bin');
    const extracted = join(root, 'extracted');
    for (const directory of [tarballs, bin, extracted]) mkdirSync(directory);
    copyFileSync(process.execPath, join(bin, 'node'));
    for (const name of [...knownPackages, '@galaxie-ai/create']) {
      const directory = join(repo, 'packages', name.slice('@galaxie-ai/'.length));
      execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 300_000,
      });
      const destination = join(root, name.slice('@galaxie-ai/'.length));
      mkdirSync(destination);
      const packed = packPackage(directory, destination);
      if (name === '@galaxie-ai/create') execFileSync('tar', ['-xzf', packed, '-C', extracted]);
      else copyFileSync(packed, join(tarballs, packed.split('/').at(-1) as string));
    }
    const cli = join(extracted, 'package/dist/cli.js');
    const env = {
      PATH: bin,
      npm_config_user_agent: 'npm/12',
      GALAXIE_CREATE_PACKAGE_DIR: tarballs,
    };
    const run = (args: string[]): string =>
      execFileSync(join(bin, 'node'), [cli, ...args], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 30_000,
      });
    expect(readdirSync(bin)).toEqual(['node']);
    expect(run(['--help'])).toContain('langgraph-js');
    expect(run(['my-app', 'browser-only', 'langgraph-js', '--no-install'])).toContain('Created');
    const project = join(root, 'my-app');
    expect(existsSync(join(project, 'node_modules'))).toBe(false);
    const expected = compose(await loadLayers(join(repo, 'templates')), {
      name: 'my-app',
      kind: 'browser-only',
      framework: 'langgraph-js',
      mode: 'project',
      packageManager: 'npm',
      tarballs: await resolveTarballs(tarballs),
      guidance: renderGuidance(await loadGuidanceSource(join(repo, 'skills/galaxie')), {
        kind: 'browser-only',
        framework: 'langgraph-js',
      }),
    });
    const actual = readdirSync(project, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(project.length + 1))
      .sort();
    expect(actual).toEqual([...expected.files.keys()].sort());
    for (const [path, file] of expected.files)
      expect(readFileSync(join(project, path)), path).toEqual(Buffer.from(file.bytes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 300_000);
