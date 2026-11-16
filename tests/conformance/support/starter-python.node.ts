// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lockedWheels } from '../../../packages/adapter-pyodide/src/runtime-files.js';
import type { StarterManifest } from '../../../packages/starter-python/src/manifest.js';
import { buildStarterDist } from '../../../scripts/build-starter-python.js';

export function hasStarterPython(): boolean {
  const cache = resolve('.cache/python-wheels');
  let localFiles: string[] = [];
  if (existsSync(join(cache, 'local-wheels.json'))) {
    const local = JSON.parse(readFileSync(join(cache, 'local-wheels.json'), 'utf8')) as {
      packages: { file: string }[];
    };
    localFiles = local.packages.map((wheel) => wheel.file);
  }
  const required = [
    'local-wheels.json',
    ...lockedWheels
      .filter((wheel) => !wheel.frameworks || wheel.frameworks.includes('langgraph'))
      .map((wheel) => wheel.file),
    ...localFiles,
  ];
  if (required.every((file) => existsSync(join(cache, file)))) return true;
  const reason =
    'The Python wheel cache is absent; run fetch-python-wheels.ts and build-python-wheels.ts before starter artifact tests.';
  if (process.env['CI']) throw new Error(reason);
  console.info(reason);
  return false;
}

export interface StarterDist {
  readonly directory: string;
  readonly manifest: StarterManifest;
}

let built: Promise<StarterDist> | undefined;
/** Compile and pack in an owned temporary package; callers mutate their own copies. */
export function buildStarterDistOnce(): Promise<StarterDist> {
  if (!built)
    built = (async () => {
      if (!hasStarterPython()) throw new Error('The Python wheel cache is required.');
      const directory = await mkdtemp(join(tmpdir(), 'galaxie-starter-python-dist-'));
      try {
        for (const name of ['package.json', 'README.md', 'LICENSE', 'NOTICE'])
          await cp(join('packages/starter-python', name), join(directory, name));
        await symlink(
          resolve('packages/starter-python/node_modules'),
          join(directory, 'node_modules'),
          'dir',
        );
        execFileSync(
          'pnpm',
          [
            'exec',
            'tsc',
            '-p',
            'packages/starter-python/tsconfig.build.json',
            '--outDir',
            join(directory, 'dist'),
            '--sourceMap',
            'false',
            '--declarationMap',
            'false',
          ],
          {
            cwd: resolve('.'),
            encoding: 'utf8',
          },
        );
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
