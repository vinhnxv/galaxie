// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const buildSettings: {
  readonly toolchain: string;
  readonly goos: string;
  readonly goarch: string;
  readonly cgo: string;
  readonly flags: readonly string[];
  readonly ldflags: string;
} = {
  toolchain: 'go1.27.3',
  goos: 'js',
  goarch: 'wasm',
  cgo: '0',
  flags: ['-mod=readonly', '-trimpath', '-buildvcs=false'],
  ldflags: '-s -w -buildid=',
};

/** Rebuild the environment so ambient Go configuration cannot change build identity. */
export function buildEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'GOPATH', 'GOMODCACHE', 'GOCACHE', 'GOPROXY', 'GOSUMDB']) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  return {
    ...result,
    GOTOOLCHAIN: 'local',
    GOENV: 'off',
    GOOS: buildSettings.goos,
    GOARCH: buildSettings.goarch,
    CGO_ENABLED: buildSettings.cgo,
    GOWORK: 'off',
    GOWASM: '',
    GOEXPERIMENT: '',
    GOFLAGS: buildSettings.flags.join(' '),
  };
}

export function checkBuildSettings(lock: {
  readonly toolchain: string;
  readonly build: {
    readonly goos: string;
    readonly goarch: string;
    readonly cgo: string;
    readonly flags: readonly string[];
    readonly ldflags: string;
  };
}): void {
  if (
    lock.toolchain !== buildSettings.toolchain ||
    lock.build.goos !== buildSettings.goos ||
    lock.build.goarch !== buildSettings.goarch ||
    lock.build.cgo !== buildSettings.cgo ||
    lock.build.ldflags !== buildSettings.ldflags ||
    JSON.stringify(lock.build.flags) !== JSON.stringify(['-trimpath'])
  )
    throw new Error('The starter build settings drift from go/wasm.lock.');
}

export async function runGo(
  args: readonly string[],
  directory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  try {
    return (
      await promisify(execFile)('go', [...args], {
        cwd: directory,
        env: buildEnvironment(environment),
        maxBuffer: 64 * 1024 * 1024,
      })
    ).stdout;
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    if (failure.stderr) throw new Error(failure.stderr);
    throw error;
  }
}

export async function buildAgent(
  directory: string,
  output: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runGo(
    ['build', `-ldflags=${buildSettings.ldflags}`, '-o', output, '.'],
    directory,
    environment,
  );
}
