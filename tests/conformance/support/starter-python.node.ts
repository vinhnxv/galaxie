// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { expect } from 'vitest';
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
  await Promise.all(
    fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  if (built) {
    const result = await built.catch(() => undefined);
    if (result) await rm(result.directory, { recursive: true, force: true });
    built = undefined;
  }
}

const repo = resolve('.');
const fixtures: string[] = [];

interface Project {
  readonly directory: string;
  readonly artifacts: string;
  readonly noPython: string;
  readonly buildScript: string;
}

export async function starterProject(
  kind: 'browser-only' | 'gateway' = 'browser-only',
): Promise<Project> {
  const composed = join(repo, `packages/create/.cache/composed/${kind}-langgraph-python`);
  const directory = await mkdtemp(join(composed, '../.starter-python-browser-'));
  fixtures.push(directory);
  await cp(composed, directory, {
    recursive: true,
    filter: (path) => {
      const top = relative(composed, path).split(sep)[0] ?? '';
      return (
        !['node_modules', 'dist', '.server'].includes(top) &&
        !/^\.(?:reload|browser)-check-/.test(top)
      );
    },
  });
  const artifacts = join(directory, '.artifacts/starter-python');
  const dist = await buildStarterDistOnce();
  await cp(dist.directory, artifacts, { recursive: true });
  const scope = join(directory, 'node_modules/@galaxie-ai');
  await mkdir(scope, { recursive: true });
  await symlink(artifacts, join(scope, 'starter-python'), 'dir');
  const noPython = join(directory, '.no-python');
  await mkdir(noPython);
  for (const command of ['python', 'python3', 'uv'])
    expect(spawnSync(command, ['--version'], { env: { PATH: noPython } }).error).toMatchObject({
      code: 'ENOENT',
    });
  await symlink(join(repo, 'packages/adapter-pyodide'), join(scope, 'adapter-pyodide'), 'dir');
  await symlink(
    join(repo, 'packages/adapter-pyodide/node_modules/pyodide'),
    join(directory, 'node_modules/pyodide'),
    'dir',
  );
  const workspace = JSON.parse(
    await readFile(join(composed, 'tsconfig.workspace.json'), 'utf8'),
  ) as {
    compilerOptions: { paths: Record<string, string[]> };
  };
  const alias = Object.entries(workspace.compilerOptions.paths)
    .filter(([name]) => name.startsWith('@galaxie-ai/'))
    .sort(([a], [b]) => b.length - a.length)
    .map(([find, paths]) => ({ find, replacement: resolve(composed, paths[0] as string) }));
  const buildScript = join(directory, '.build.mjs');
  await writeFile(
    buildScript,
    `import { build } from ${JSON.stringify(import.meta.resolve('vite'))};
await build({ configFile: ${JSON.stringify(join(directory, 'vite.config.ts'))}, mode: 'mock', logLevel: 'silent', resolve: { alias: ${JSON.stringify(alias)} }, build: { outDir: process.argv[2], emptyOutDir: true } });
`,
  );
  return { directory, artifacts, noPython, buildScript };
}

export async function buildProject(
  fixture: Project,
  name: string,
): Promise<{
  directory: string;
  status: number | null;
  output: string;
}> {
  const directory = join(fixture.directory, name);
  const child = spawn(process.execPath, [fixture.buildScript, directory], {
    cwd: fixture.directory,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PATH: fixture.noPython,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const status = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  return { directory, status, output };
}
