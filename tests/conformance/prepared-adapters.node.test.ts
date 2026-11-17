// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createAdkAdapter } from '../../packages/adapter-adk/src/index.js';
import { createGoAdapter } from '../../packages/adapter-go/src/index.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/index.js';
import { version as starterGoVersion } from '../../packages/starter-go/src/index.js';
import { version as starterPythonVersion } from '../../packages/starter-python/src/index.js';
import { launchPackages } from '../../scripts/standalone-core.js';

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly engines?: { readonly node?: string };
}

function readManifest(directory: string): Manifest {
  try {
    return JSON.parse(
      readFileSync(new URL(`../../${directory}/package.json`, import.meta.url), 'utf8'),
    ) as Manifest;
  } catch (error) {
    if (
      directory.startsWith('packages/create/.cache/') &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      throw new Error(
        `Missing composed manifest: ${directory}/package.json. Run pnpm run compose:create before testing prepared adapters.`,
        { cause: error },
      );
    throw error;
  }
}

const coreVersion = readManifest('packages/core').version;
const prepared = [
  'adapter-pyodide',
  'adapter-adk',
  'adapter-go',
  'starter-go',
  'starter-python',
].map((directory) => ({
  directory,
  manifest: readManifest(`packages/${directory}`),
}));
const templates = ['browser-only', 'gateway']
  .flatMap((kind) =>
    ['langgraph-js', 'adk-js', 'adk-go', 'langgraph-python'].map(
      (framework) => `${kind}-${framework}`,
    ),
  )
  .map((directory) => ({
    directory,
    manifest: readManifest(`packages/create/.cache/composed/${directory}`),
  }));
const publicPackages = readdirSync(new URL('../../packages/', import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map(({ name }) => ({ directory: name, manifest: readManifest(`packages/${name}`) }))
  .filter(({ manifest }) => manifest.private !== true);
const templateNodeRange = (
  JSON.parse(readFileSync(new URL('../../templates/base/layer.json', import.meta.url), 'utf8')) as {
    package: Manifest;
  }
).package.engines?.node;
const createWorker = (): never => {
  throw new Error('Adapter version checks must not create a Worker.');
};
const options = {
  createWorker,
  runtimeUrl: 'https://runtime.example/',
  wheelsUrl: 'https://wheels.example/',
  localWheels: [],
};
const versions: Readonly<Record<string, readonly string[]>> = {
  'starter-go': [starterGoVersion],
  'starter-python': [starterPythonVersion],
  'adapter-adk': [createAdkAdapter().version],
  'adapter-go': [createGoAdapter({ createWorker }).version],
  'adapter-pyodide': [
    createPyodideAdapter(options).version,
    ...(['langgraph', 'pydantic-ai', 'dspy', 'adk'] as const).map(
      (framework) => createPyodideAdapter({ ...options, framework }).version,
    ),
  ],
};

function mismatchedEngines(entries: typeof templates): string[] {
  return entries
    .filter(({ manifest }) => manifest.engines?.node !== templateNodeRange)
    .map(({ directory }) => directory);
}

function versionProblems(manifest: Manifest, advertised: readonly string[]): string[] {
  return advertised.length === 0 || advertised.some((version) => version !== manifest.version)
    ? ['version']
    : [];
}

function publicationProblems(
  manifest: Manifest,
  launches: readonly string[],
  budgets: readonly string[],
): string[] {
  const problems: string[] = [];
  if (manifest.private !== undefined) problems.push('private');
  if (launches.includes(manifest.name)) problems.push('launch');
  if (!budgets.some((entry) => entry.startsWith(`${manifest.name}/`))) problems.push('size-budget');
  return problems;
}

test.each(prepared)(
  '$directory advertises its manifest version for every framework',
  ({ directory, manifest }) => {
    expect(manifest.version).toBe(coreVersion);
    const advertised = versions[directory] ?? [];
    expect(versionProblems(manifest, advertised)).toEqual([]);
    expect(versionProblems({ ...manifest, version: '0.0.1' }, advertised)).toEqual(['version']);
  },
);

test('every public package and composed project declares the base template Node range', () => {
  expect(templateNodeRange).toBe('>=22.22.2');
  expect(publicPackages).toHaveLength(13);
  expect(templates).toHaveLength(8);
  const entries = [...publicPackages, ...templates];
  expect(mismatchedEngines(entries)).toEqual([]);
  for (const entry of entries)
    expect(
      mismatchedEngines(
        entries.map((item) =>
          item === entry
            ? { ...item, manifest: { ...item.manifest, engines: { node: '>=24' } } }
            : item,
        ),
      ),
    ).toEqual([entry.directory]);
});

test('promoted adapters are public and budgeted while standalone extras remain conditional', () => {
  const budget = JSON.parse(
    readFileSync(new URL('../../scripts/size-budget.json', import.meta.url), 'utf8'),
  ) as { entries: Record<string, unknown> };
  const entries = Object.keys(budget.entries);
  for (const { manifest } of prepared) {
    expect(publicationProblems(manifest, launchPackages, entries)).toEqual([]);
    expect(publicationProblems({ ...manifest, private: false }, launchPackages, entries)).toEqual([
      'private',
    ]);
    expect(publicationProblems(manifest, [...launchPackages, manifest.name], entries)).toEqual([
      'launch',
    ]);
    expect(
      publicationProblems(
        manifest,
        launchPackages,
        entries.filter((entry) => !entry.startsWith(`${manifest.name}/`)),
      ),
    ).toEqual(['size-budget']);
  }
});

test('all promoted packages join the dependency-license list', () => {
  const source = readFileSync(
    new URL('../../scripts/check-dependency-licenses.ts', import.meta.url),
    'utf8',
  );
  const listed = /const launchPackages = \[([^\]]*)\]/.exec(source)?.[1];
  expect(listed).toBeDefined();
  const directories = [...(listed ?? '').matchAll(/'packages\/([^']+)'/g)].map((match) => match[1]);
  // The standalone base set stays at seven; the license audit covers all thirteen.
  expect(directories).toContain('core');
  expect(launchPackages).toHaveLength(7);
  expect(directories).toHaveLength(13);
  for (const { directory } of prepared) expect(directories).toContain(directory);
  expect(directories).toContain('create');
});

test('missing composed manifests explain how to prepare the cache', () => {
  expect(() => readManifest('packages/create/.cache/composed/missing-fixture')).toThrow(
    'Run pnpm run compose:create',
  );
});
