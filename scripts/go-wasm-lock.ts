// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface LockedGoModule {
  readonly path: string;
  readonly version: string;
  readonly license: string;
  /** The version's commit time as the module proxy reports it. */
  readonly time: string;
  /** The checksum database record number: it grows with the order in which versions were first verified. */
  readonly sumdbRecord: number;
}

export interface GoWasmLock {
  readonly v: 'galaxie.go-wasm-lock/v1';
  readonly toolchain: string;
  readonly build: {
    readonly goos: 'js';
    readonly goarch: 'wasm';
    readonly cgo: '0';
    readonly flags: readonly string[];
    readonly ldflags: string;
  };
  /** The packages whose wasm builds the module list covers. */
  readonly packages: readonly string[];
  readonly cutoff: string;
  /** The checksum database record number of the first version the module index lists at the cutoff. */
  readonly cutoffRecord: number;
  readonly glue: { readonly file: 'wasm_exec.js'; readonly sha256: string; readonly bytes: number };
  readonly modules: readonly LockedGoModule[];
}

export const lockUrl: URL = new URL('../go/wasm.lock', import.meta.url);
export const goDirectory: string = fileURLToPath(new URL('../go/', import.meta.url));
export const cacheDirectory: string = fileURLToPath(new URL('../.cache/go-wasm/', import.meta.url));
export const allowedLicenses: readonly string[] = [
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'MIT',
  'ISC',
];

export async function readGoWasmLock(): Promise<GoWasmLock> {
  return JSON.parse(await readFile(lockUrl, 'utf8')) as GoWasmLock;
}

/**
 * The environment every Go command runs in: no toolchain download, no cgo, the wasm target, and
 * none of the variables that change the module graph or the emitted bytes (a stray go.work, GOWASM,
 * GOEXPERIMENT or a module-flag override in the caller's shell).
 */
export function goEnvironment(lock?: GoWasmLock): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GOTOOLCHAIN: 'local',
    GOOS: 'js',
    GOARCH: 'wasm',
    CGO_ENABLED: '0',
    GOWORK: 'off',
    GOWASM: '',
    GOEXPERIMENT: '',
    GOFLAGS: ['-mod=readonly', ...(lock ? lock.build.flags : ['-trimpath'])].join(' '),
  };
}

export function goInstalled(): boolean {
  return spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0;
}

export function runGo(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  directory: string = goDirectory,
): string {
  const result = spawnSync('go', [...args], {
    cwd: directory,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`go ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** The modules compiled into the wasm build of the packages, excluding the galaxie module itself. */
export function wasmModules(
  lock: Pick<GoWasmLock, 'packages'>,
): Array<{ path: string; version: string }> {
  const output = runGo(
    ['list', '-deps', '-f', '{{with .Module}}{{.Path}} {{.Version}}{{end}}', ...lock.packages],
    goEnvironment(),
  );
  const found = new Map<string, string>();
  for (const line of output.split('\n')) {
    const [path, version] = line.trim().split(' ');
    if (path && version) found.set(path, version);
  }
  return [...found].map(([path, version]) => ({ path, version })).sort(byPath);
}

export function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
