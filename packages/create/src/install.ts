// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import type { PackageManager } from './packages.js';

export interface InstallCommand {
  readonly executable: PackageManager;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
}
export type InstallRunner = (command: InstallCommand) => Promise<void>;
export class InstallError extends Error {}

export function detectPackageManager(userAgent: string | undefined): {
  packageManager: PackageManager;
  note?: string;
} {
  if (userAgent === undefined || userAgent === '') return { packageManager: 'npm' };
  const name = userAgent.split('/')[0];
  if (name === 'npm' || name === 'pnpm' || name === 'yarn') return { packageManager: name };
  return { packageManager: 'npm', note: 'Unrecognized package manager; using npm.' };
}

const spawnInstall: InstallRunner = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      env: command.env,
      shell: command.shell,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new InstallError());
    });
  });

export function installFlag(packageManager: PackageManager, tarballMode: boolean): string {
  return tarballMode && packageManager === 'yarn' ? '--mode=skip-build' : '--ignore-scripts';
}

export async function install(
  packageManager: PackageManager,
  cwd: string,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly runner?: InstallRunner;
    readonly tarballMode?: boolean;
  } = {},
): Promise<boolean> {
  if ((options.platform ?? process.platform) === 'win32') return false;
  const yarnTarballs = options.tarballMode === true && packageManager === 'yarn';
  const flag = installFlag(packageManager, options.tarballMode === true);
  const env = options.env ?? process.env;
  try {
    await (options.runner ?? spawnInstall)({
      executable: packageManager,
      args: ['install', flag],
      cwd,
      // Yarn Classic ignores --mode=skip-build if it bypasses the Corepack pin.
      env: yarnTarballs ? { ...env, YARN_IGNORE_SCRIPTS: 'true' } : env,
      shell: false,
    });
    return true;
  } catch {
    throw new InstallError(
      `Installation failed. Run ${packageManager} install ${flag} in the project directory.`,
    );
  }
}
