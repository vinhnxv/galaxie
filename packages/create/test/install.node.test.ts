// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { chmodSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import {
  detectPackageManager,
  type InstallCommand,
  InstallError,
  install,
} from '../src/install.js';

test.each(['npm', 'pnpm', 'yarn'] as const)(
  'detects and installs with %s without a shell or lifecycle scripts',
  async (packageManager) => {
    expect(detectPackageManager(`${packageManager}/1.0 node/v24`)).toEqual({ packageManager });
    const commands: InstallCommand[] = [];
    const env = { PATH: '/bin', npm_config_user_agent: `${packageManager}/1.0` };
    expect(
      await install(packageManager, '/projects/my-app', {
        env,
        platform: 'darwin',
        runner: async (command) => {
          commands.push(command);
        },
      }),
    ).toBe(true);
    expect(commands).toEqual([
      {
        executable: packageManager,
        args: ['install', '--ignore-scripts'],
        cwd: '/projects/my-app',
        env,
        shell: false,
      },
    ]);
  },
);

test('defaults to npm and gives a fixed fallback note for an unknown manager', () => {
  expect(detectPackageManager(undefined)).toEqual({ packageManager: 'npm' });
  expect(detectPackageManager('bun/1.0')).toEqual({
    packageManager: 'npm',
    note: 'Unrecognized package manager; using npm.',
  });
});

test('Windows does not invoke a command shim and failures do not expose child diagnostics', async () => {
  let calls = 0;
  const runner = async (): Promise<void> => {
    calls++;
    throw new Error('document-value-canary');
  };
  expect(await install('npm', '/projects/my-app', { platform: 'win32', runner })).toBe(false);
  expect(calls).toBe(0);
  await expect(
    install('npm', '/projects/my-app', { platform: 'darwin', runner }),
  ).rejects.toBeInstanceOf(InstallError);
  await expect(
    install('npm', '/projects/my-app', { platform: 'darwin', runner }),
  ).rejects.not.toThrow('document-value-canary');
  expect(calls).toBe(2);
});

test.skipIf(process.platform === 'win32')(
  'the real spawn passes --ignore-scripts, keeps the working directory and reports a failed install',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'galaxie-create-spawn-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, 'bin');
    await mkdir(bin);
    const record = join(root, 'record.txt');
    const fake = join(bin, 'npm');
    await writeFile(
      fake,
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$GALAXIE_FAKE_RECORD"\npwd -P >> "$GALAXIE_FAKE_RECORD"\nprintf "%s\\n" "$npm_config_ignore_scripts" >> "$GALAXIE_FAKE_RECORD"\n',
    );
    chmodSync(fake, 0o755);
    const project = join(root, 'proj $(touch pwned); `touch pwned2`');
    await mkdir(project);
    await install('npm', project, {
      env: { PATH: bin, GALAXIE_FAKE_RECORD: record, npm_config_ignore_scripts: 'false' },
      platform: 'linux',
    });
    const lines = (await readFile(record, 'utf8')).trim().split('\n');
    // argv, then the working directory, then the inherited environment value.
    expect(lines.slice(0, 2)).toEqual(['install', '--ignore-scripts']);
    expect(lines[2]?.endsWith('proj $(touch pwned); `touch pwned2`')).toBe(true);
    expect(lines[3]).toBe('false');
    for (const name of ['pwned', 'pwned2'])
      await expect(readFile(join(project, name))).rejects.toThrow();
    // Negative control: a non-zero exit is reported as an InstallError with the manual command.
    await writeFile(fake, '#!/bin/sh\nexit 3\n');
    await expect(
      install('npm', project, { env: { PATH: bin }, platform: 'linux' }),
    ).rejects.toThrow(InstallError);
  },
);
