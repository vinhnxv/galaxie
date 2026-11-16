// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';
import { expect, it } from 'vitest';
import { cspHeader as goRecipeCsp } from '../../../examples/adk-recipes/src/host/csp.js';
import { compose } from '../src/compose.js';
import { loadLayers } from '../src/layers.js';
import { planWrite, writeProject } from '../src/write.js';

const templates = fileURLToPath(new URL('../../../templates', import.meta.url));
const scratch = fileURLToPath(new URL('../.cache/negative/', import.meta.url));
const compiler = join(
  dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
  'bin/tsc',
);
const layers = loadLayers(templates);

interface Mutation {
  readonly name: string;
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly directive: string;
}

function mutations(kind: string): readonly Mutation[] {
  const browser = kind === 'browser-only';
  return [
    {
      name: 'an inline script allowance',
      path: 'src/csp.ts',
      before: browser
        ? "'script-src': [\"'self'\", \"'wasm-unsafe-eval'\"]"
        : "'script-src': frameworkProfile.workers ? [\"'self'\", \"'wasm-unsafe-eval'\"] : [\"'self'\"]",
      after: browser
        ? "'script-src': [\"'self'\", \"'wasm-unsafe-eval'\", \"'unsafe-inline'\"]"
        : "'script-src': frameworkProfile.workers ? [\"'self'\", \"'wasm-unsafe-eval'\", \"'unsafe-inline'\"] : [\"'self'\", \"'unsafe-inline'\"]",
      directive: 'script-src',
    },
    {
      name: 'removed Trusted Types enforcement',
      path: 'src/csp.ts',
      before: "    'require-trusted-types-for': [\"'script'\"],\n",
      after: '',
      directive: 'require-trusted-types-for',
    },
    {
      name: 'a widened Trusted Types policy list',
      path: 'src/csp.ts',
      before: browser
        ? "'trusted-types': mode === 'mock' && !workers ? [\"'none'\"] : ['default']"
        : "'trusted-types': frameworkProfile.workers ? ['default'] : [\"'none'\"]",
      after: "'trusted-types': ['*']",
      directive: 'trusted-types',
    },
    ...(['server', 'preview'] as const).map((target) => ({
      name: `removed Vite ${target} headers`,
      path: 'vite.config.ts',
      before: browser
        ? `${target}: { headers: { 'Content-Security-Policy': cspHeader(mode, frameworkProfile.workers) } }`
        : `${target}: { host: '127.0.0.1', headers: { 'Content-Security-Policy': cspHeader() } }`,
      after: browser ? `${target}: {}` : `${target}: { host: '127.0.0.1' }`,
      directive: 'Content-Security-Policy',
    })),
    ...(browser
      ? []
      : [
          {
            name: 'removed static server headers',
            path: 'server/serve.ts',
            before: "response.setHeader('Content-Security-Policy', cspHeader());",
            after: 'void cspHeader;',
            directive: 'Content-Security-Policy',
          },
          {
            name: 'a production import of the mock upstream',
            path: 'server/serve.ts',
            before: "import { cspHeader } from '../src/csp.js';",
            after: "import { cspHeader } from '../src/csp.js';\nimport './mock-upstream.js';",
            directive: 'mock-upstream',
          },
          {
            name: 'a compiled server program that includes the mock upstream',
            path: 'server/tsconfig.json',
            before: '"include": ["gateway.ts", "serve.ts", "../src/csp.ts"]',
            after: '"include": ["gateway.ts", "serve.ts", "mock-upstream.ts", "../src/csp.ts"]',
            directive: 'mock-upstream',
          },
        ]),
  ];
}

async function project(
  kind: string,
  mutation?: Mutation,
  framework = 'langgraph-js',
  workers = false,
): Promise<string> {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, `${kind}-`));
  try {
    const result = compose(await layers, {
      kind,
      framework,
      name: `${kind}-baseline`,
      mode: 'project',
      packageManager: 'npm',
    });
    await writeProject(await planWrite(result.files, directory));
    if (workers) {
      const profile = join(directory, 'src/framework-profile.ts');
      await writeFile(
        profile,
        (await readFile(profile, 'utf8')).replace('workers: false', 'workers: true'),
      );
    }
    if (kind === 'gateway') expect(result.files.has('server/mock-upstream.ts')).toBe(true);
    if (mutation !== undefined) {
      const path = join(directory, mutation.path);
      const original = await readFile(path, 'utf8');
      expect(original).toContain(mutation.before);
      const changed = original.replace(mutation.before, mutation.after);
      expect(changed).not.toBe(original);
      await writeFile(path, changed);
    }
    if (kind === 'gateway') {
      const compiled = spawnSync(process.execPath, [compiler, '-p', 'server/tsconfig.json'], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(compiled.error).toBeUndefined();
      expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
    }
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

for (const framework of ['langgraph-js', 'adk-js', 'adk-go', 'langgraph-python']) {
  for (const kind of ['browser-only', 'gateway']) {
    for (const workers of ['adk-go', 'langgraph-python'].includes(framework)
      ? [true]
      : [false, true]) {
      if (workers && !['adk-go', 'langgraph-python'].includes(framework)) {
        it(`${kind}-${framework} generated baseline rejects a worker profile without the Go starter`, async () => {
          const directory = await project(kind, undefined, framework, true);
          try {
            const result = spawnSync(process.execPath, ['--test', 'check/baseline.check.ts'], {
              cwd: directory,
              encoding: 'utf8',
              timeout: 30_000,
            });
            expect(result.error).toBeUndefined();
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain('framework profile changed');
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }, 60_000);
        continue;
      }
      it(`${kind}-${framework} workers=${workers} generated baseline accepts an unmodified project`, async () => {
        const directory = await project(kind, undefined, framework, workers);
        try {
          const result = spawnSync(process.execPath, ['--test', 'check/baseline.check.ts'], {
            cwd: directory,
            encoding: 'utf8',
            timeout: 30_000,
          });
          expect(result.error).toBeUndefined();
          expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }, 60_000);

      for (const mutation of mutations(kind)) {
        it(`${kind}-${framework} workers=${workers} generated baseline rejects ${mutation.name}`, async () => {
          const directory = await project(kind, mutation, framework, workers);
          try {
            const result = spawnSync(process.execPath, ['--test', 'check/baseline.check.ts'], {
              cwd: directory,
              encoding: 'utf8',
              timeout: 30_000,
            });
            expect(result.error).toBeUndefined();
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(mutation.directive);
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }, 60_000);
      }
    }
  }
}

it.each(['browser-only', 'gateway'])(
  'the %s ADK Go mock header equals the existing Go recipe header without an installed starter package',
  async (kind) => {
    const directory = await project(kind, undefined, 'adk-go', true);
    try {
      const declared = await loadConfigFromFile(
        { command: 'serve', mode: 'mock' },
        join(directory, 'vite.config.ts'),
        undefined,
        'silent',
      );
      expect(declared?.config.preview?.headers?.['Content-Security-Policy']).toBe(
        goRecipeCsp('mock'),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

for (const kind of ['browser-only', 'gateway']) {
  for (const mutation of ['dependency', 'profile']) {
    it(kind + ' Python baseline rejects a changed ' + mutation, async () => {
      const directory = await project(kind, undefined, 'langgraph-python', true);
      try {
        if (mutation === 'dependency') {
          const path = join(directory, 'package.json');
          const manifest = JSON.parse(await readFile(path, 'utf8'));
          delete manifest.dependencies['@galaxie-ai/starter-python'];
          await writeFile(path, JSON.stringify(manifest));
        } else {
          const path = join(directory, 'src/framework-profile.ts');
          await writeFile(
            path,
            (await readFile(path, 'utf8')).replace('workers: true', 'workers: false'),
          );
        }
        const result = spawnSync(process.execPath, ['--test', 'check/baseline.check.ts'], {
          cwd: directory,
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).toContain('framework profile changed');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 60_000);
  }
}
