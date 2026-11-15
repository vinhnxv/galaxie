// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
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
