// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildEnvironment, buildSettings } from '../../../packages/starter-go/src/build-env.js';
import type { StarterManifest } from '../../../packages/starter-go/src/manifest.js';
import { buildStarterDist } from '../../../scripts/build-starter-go.js';

export function hasStarterGo(): boolean {
  const result = spawnSync('go', ['env', 'GOVERSION'], {
    env: buildEnvironment(),
    encoding: 'utf8',
  });
  if (result.stdout?.trim() === buildSettings.toolchain) return true;
  const reason = 'Go 1.27.3 is not on PATH; skipping Go starter artifact builds.';
  if (process.env['CI']) throw new Error(reason);
  console.info(reason);
  return false;
}
export interface StarterDist {
  readonly directory: string;
  readonly manifest: StarterManifest;
}
let built: Promise<StarterDist> | undefined;
/** Shared per test process; callers own copies when they mutate an artifact. */
export function buildStarterDistOnce(): Promise<StarterDist> {
  if (!built)
    built = (async () => {
      if (!hasStarterGo()) throw new Error('Go 1.27.3 is required to build starter artifacts.');
      execFileSync('pnpm', ['exec', 'tsc', '-p', 'packages/starter-go/tsconfig.build.json'], {
        cwd: resolve('.'),
        encoding: 'utf8',
      });
      const directory = await mkdtemp(join(tmpdir(), 'galaxie-starter-dist-'));
      await cp('packages/starter-go/package.json', join(directory, 'package.json'));
      await mkdir(join(directory, 'dist'));
      await cp('packages/starter-go/dist', join(directory, 'dist'), {
        recursive: true,
        filter: (p) => !p.endsWith('agent.wasm') && !p.endsWith('go-module'),
      });
      try {
        return { directory, manifest: await buildStarterDist(directory) };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    })();
  return built;
}
export async function cleanStarterDist(): Promise<void> {
  if (built) {
    const result = await built.catch(() => undefined);
    if (result) await rm(result.directory, { recursive: true, force: true });
    built = undefined;
  }
}
