// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
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
  return JSON.parse(
    readFileSync(new URL(`../../${directory}/package.json`, import.meta.url), 'utf8'),
  ) as Manifest;
}

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
const templates = [
  'browser-only-langgraph-js',
  'gateway-langgraph-js',
  'browser-only-adk-js',
  'gateway-adk-js',
  'browser-only-adk-go',
  'gateway-adk-go',
].map((directory) => ({
  directory,
  manifest: readManifest(`packages/create/.cache/composed/${directory}`),
}));
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
    .filter(({ manifest }) => manifest.engines?.node !== '>=22.22.2')
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
  if (manifest.private !== true) problems.push('private');
  if (launches.includes(manifest.name)) problems.push('launch');
  if (budgets.some((entry) => entry.startsWith(`${manifest.name}/`))) problems.push('size-budget');
  return problems;
}

test.each(prepared)(
  '$directory advertises its manifest version for every framework',
  ({ directory, manifest }) => {
    expect(manifest.version).toBe('0.0.0');
    const advertised = versions[directory] ?? [];
    expect(versionProblems(manifest, advertised)).toEqual([]);
    expect(versionProblems({ ...manifest, version: '0.0.1' }, advertised)).toEqual(['version']);
  },
);

test('prepared adapters and both starters declare the same Node floor', () => {
  const entries = [...prepared, ...templates];
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

test('prepared adapters remain private and outside standalone launch and size budgets', () => {
  const budget = JSON.parse(
    readFileSync(new URL('../../scripts/size-budget.json', import.meta.url), 'utf8'),
  ) as { entries: Record<string, unknown> };
  const entries = Object.keys(budget.entries);
  for (const { manifest } of prepared) {
    expect(publicationProblems(manifest, launchPackages, entries)).toEqual([]);
    const { private: omitted, ...withoutPrivate } = manifest;
    expect(omitted).toBe(true);
    expect(publicationProblems(withoutPrivate, launchPackages, entries)).toEqual(['private']);
    expect(publicationProblems({ ...manifest, private: false }, launchPackages, entries)).toEqual([
      'private',
    ]);
    expect(publicationProblems(manifest, [...launchPackages, manifest.name], entries)).toEqual([
      'launch',
    ]);
    expect(
      publicationProblems(manifest, launchPackages, [...entries, `${manifest.name}/.`]),
    ).toEqual(['size-budget']);
  }
});

test('prepared adapters stay out of the dependency-license launch list', () => {
  const source = readFileSync(
    new URL('../../scripts/check-dependency-licenses.ts', import.meta.url),
    'utf8',
  );
  const listed = /const launchPackages = \[([^\]]*)\]/.exec(source)?.[1];
  expect(listed).toBeDefined();
  const directories = [...(listed ?? '').matchAll(/'packages\/([^']+)'/g)].map((match) => match[1]);
  // Positive control: the parser sees the real list before absence is claimed.
  expect(directories).toContain('core');
  expect(directories).toHaveLength(7);
  for (const { directory } of prepared) expect(directories).not.toContain(directory);
});
