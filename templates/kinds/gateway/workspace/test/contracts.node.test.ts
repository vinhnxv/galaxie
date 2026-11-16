// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { cspDirectives } from '../src/csp.js';
import { templateDefinition } from '../src/executor.js';
import { gatewayStateForStatus, gatewayStates } from '../src/gateway-state.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const framework = JSON.parse(
  await readFile(
    resolve(root, '../../../../../templates/frameworks', templateDefinition.executor, 'layer.json'),
    'utf8',
  ),
) as { package: { dependencies: Record<string, string> } };
const frameworkDependencies = framework.package.dependencies;
const launch = [
  '@galaxie-ai/core',
  ...Object.keys(frameworkDependencies).filter((name) => name.startsWith('@galaxie-ai/')),
  '@galaxie-ai/models',
  '@galaxie-ai/react',
];

it('declares exactly four launch packages, registry ranges and the existing third-party pins', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    private: boolean;
    license: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  expect(manifest).toMatchObject({
    name: `gateway-${templateDefinition.executor}`,
    version: '0.0.0',
    private: true,
    license: 'Apache-2.0',
  });
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  expect(
    Object.keys(dependencies)
      .filter((name) => name.startsWith('@galaxie-ai/'))
      .sort(),
  ).toEqual([...launch].sort());
  for (const name of launch) expect(dependencies[name]).toBe('^0.1.0');
  const thirdParties = {
    ...Object.fromEntries(
      Object.entries(frameworkDependencies).filter(([name]) => !name.startsWith('@galaxie-ai/')),
    ),
    react: '19.3.1',
    'react-dom': '19.3.1',
    '@langchain/openai': '1.6.3',
    vite: '8.3.4',
    playwright: '1.64.1',
    typescript: '7.0.2',
    '@types/node': '24.19.2',
    '@types/react': '19.3.0',
    '@types/react-dom': '19.3.0',
  };
  expect(manifest.scripts['build:server']).toBe('tsc -p server/tsconfig.json');
  expect(
    Object.fromEntries(
      Object.entries(dependencies).filter(([name]) => !name.startsWith('@galaxie-ai/')),
    ),
  ).toEqual(thirdParties);
  for (const version of Object.values(dependencies)) expect(version).not.toContain('workspace:');
});

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? sources(resolve(directory, entry.name))
          : Promise.resolve(/\.tsx?$/.test(entry.name) ? [resolve(directory, entry.name)] : []),
      ),
    )
  ).flat();
}

it('keeps executable imports within the copied template or launch packages', async () => {
  const files = [
    ...(await sources(resolve(root, 'src'))),
    ...(await sources(resolve(root, 'server'))),
    resolve(root, 'vite.config.ts'),
  ];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    expect(source).toMatch(
      /^\/\/ SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n\/\/ SPDX-License-Identifier: Apache-2.0/,
    );
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier === undefined) throw new Error('The import has no specifier.');
      if (specifier.startsWith('@galaxie-ai/')) {
        expect(launch).toContain(specifier.split('/').slice(0, 2).join('/'));
      }
      if (specifier.startsWith('.')) {
        const path = relative(root, resolve(dirname(file), specifier));
        expect(path.startsWith('..') || isAbsolute(path)).toBe(false);
        expect(specifier).toMatch(/\.js$/);
      }
    }
  }
});

it('keeps fixed states and a same-origin CSP with required Trusted Types', () => {
  expect(Object.keys(gatewayStates).sort()).toEqual([
    'denied',
    'mock',
    'quota_exceeded',
    'ready',
    'unavailable',
  ]);
  for (const entry of Object.values(gatewayStates)) {
    expect(Object.keys(entry).sort()).toEqual(['control', 'message']);
    expect(entry.message).not.toMatch(/https?:|token|stack|raw-error-canary/);
    expect(entry.control === null || entry.control === 'retry').toBe(true);
  }
  expect([401, 403, 429, 500, 200].map(gatewayStateForStatus)).toEqual([
    'denied',
    'denied',
    'quota_exceeded',
    'unavailable',
    'ready',
  ]);
  expect(cspDirectives()['connect-src']).toEqual(["'self'"]);
  expect(cspDirectives()['require-trusted-types-for']).toEqual(["'script'"]);
  expect(cspDirectives()['trusted-types']).toEqual(["'none'"]);
});
