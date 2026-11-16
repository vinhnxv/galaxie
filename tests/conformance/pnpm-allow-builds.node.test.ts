// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';
import { compose } from '../../packages/create/src/compose.js';
import { loadLayers } from '../../packages/create/src/layers.js';

test('pnpm 11 installs offline with closed stdin and never runs a refused protobufjs script', async () => {
  const root = await mkdtemp(join(tmpdir(), 'galaxie-build-policy-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'protobufjs');
  await mkdir(fixture);
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({
      name: 'protobufjs',
      version: '1.0.0',
      scripts: { postinstall: 'node build.cjs' },
    }),
  );
  await writeFile(
    join(fixture, 'build.cjs'),
    "require('node:fs').writeFileSync('built-sentinel', 'ran');\n",
  );
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', root], {
    cwd: fixture,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  expect(packed.status, packed.stdout + packed.stderr).toBe(0);
  const layers = await loadLayers(fileURLToPath(new URL('../../templates', import.meta.url)));
  const project = compose(layers, {
    name: 'build-policy',
    kind: 'browser-only',
    framework: 'adk-js',
    packageManager: 'pnpm',
    mode: 'project',
  });
  const yaml = project.files.get('pnpm-workspace.yaml');
  expect(yaml).toBeDefined();
  const manifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { packageManager: string };
  for (const policy of [false, true]) {
    const cwd = join(root, policy ? 'with-policy' : 'control');
    await mkdir(cwd);
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        packageManager: manifest.packageManager,
        dependencies: { protobufjs: 'file:' + join(root, 'protobufjs-1.0.0.tgz') },
      }),
    );
    const env = { ...process.env, COREPACK_ENABLE_NETWORK: '0' };
    const version = spawnSync('pnpm', ['--version'], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toMatch(/^11\./);
    if (policy) await writeFile(join(cwd, 'pnpm-workspace.yaml'), yaml!.bytes);
    const installed = spawnSync(
      'pnpm',
      ['install', '--offline', '--store-dir', join(root, 'store')],
      { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
    );
    const output = installed.stdout + installed.stderr;
    expect(installed.status, output).toBe(policy ? 0 : 1);
    if (!policy) expect(output).toContain('ERR_PNPM_IGNORED_BUILDS');
    expect(existsSync(join(cwd, 'node_modules/protobufjs/built-sentinel'))).toBe(false);
  }
}, 60_000);
