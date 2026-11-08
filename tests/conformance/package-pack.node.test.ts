// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';

interface Manifest {
  readonly version: string;
  readonly private?: boolean;
  readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly publishConfig?: { readonly access?: string };
  readonly repository?: { readonly url?: string };
  readonly homepage?: string;
  readonly bugs?: { readonly url?: string };
}

const root = fileURLToPath(new URL('../..', import.meta.url));
const launchPackages = [
  'ui-protocol',
  'core',
  'adapter-kit',
  'adapter-langgraph',
  'models',
  'storage-indexeddb',
  'react',
];

function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Manifest;
}

const coreVersion = readManifest(join(root, 'packages/core')).version;
const packages = launchPackages.map((directory) => ({
  directory,
  source: readManifest(join(root, 'packages', directory)),
  entries: [] as string[],
  packedJson: '',
}));
let temporaryDirectory: string | undefined;

beforeAll(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'galaxie-package-pack-'));
  for (const { directory } of packages) {
    execFileSync('pnpm', ['exec', 'tsc', '-p', `packages/${directory}/tsconfig.build.json`], {
      cwd: root,
      encoding: 'utf8',
      timeout: 300_000,
    });
  }
  for (const pkg of packages) {
    const destination = join(temporaryDirectory, pkg.directory);
    mkdirSync(destination);
    execFileSync('pnpm', ['pack', '--pack-destination', destination], {
      cwd: join(root, 'packages', pkg.directory),
      encoding: 'utf8',
      timeout: 300_000,
    });
    const [filename] = readdirSync(destination).filter((name) => name.endsWith('.tgz'));
    if (filename === undefined) throw new Error(`No tarball produced for ${pkg.directory}.`);
    const tarball = join(destination, filename);
    pkg.entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
      .trim()
      .split(/\r?\n/);
    pkg.packedJson = execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], {
      encoding: 'utf8',
    });
  }
}, 600_000);

afterAll(() => {
  if (temporaryDirectory !== undefined)
    rmSync(temporaryDirectory, { recursive: true, force: true });
});

test.each(packages)('$directory packs only distribution files and includes every export', (pkg) => {
  for (const name of ['package.json', 'README.md', 'LICENSE', 'NOTICE'])
    expect(pkg.entries).toContain(`package/${name}`);
  expect(pkg.entries.some((entry) => entry.startsWith('package/dist/'))).toBe(true);
  const manifest = JSON.parse(pkg.packedJson) as Manifest;
  for (const targets of Object.values(manifest.exports)) {
    for (const target of Object.values(targets))
      expect(pkg.entries).toContain(`package/${target.replace(/^\.\//, '')}`);
  }
  for (const entry of pkg.entries) {
    expect(entry).toMatch(/^package\/(?:dist\/|LICENSE$|NOTICE$|README\.md$|package\.json$)/);
    expect(entry).not.toMatch(/^package\/(?:src|test)\//);
    expect(entry.split('/')).not.toContain('internal');
  }
});

test.each(packages)('$directory packs resolved workspace dependencies', (pkg) => {
  expect(pkg.packedJson).not.toContain('workspace:');
  const manifest = JSON.parse(pkg.packedJson) as Manifest;
  for (const dependency of [
    '@galaxie-ai/core',
    '@galaxie-ai/adapter-kit',
    '@galaxie-ai/ui-protocol',
  ]) {
    if (pkg.source.dependencies?.[dependency] !== undefined)
      expect(manifest.dependencies?.[dependency]).toBe(coreVersion);
  }
});

test('React packs its protocol dependency at the shared release version', () => {
  const react = packages.find((pkg) => pkg.directory === 'react');
  expect(react?.source.dependencies?.['@galaxie-ai/ui-protocol']).toBe('workspace:*');
  const manifest = JSON.parse(react?.packedJson ?? '{}') as Manifest;
  expect(manifest.dependencies?.['@galaxie-ai/ui-protocol']).toBe(coreVersion);
});

test.each(packages)('$directory has public metadata and the root license files', (pkg) => {
  const packed = JSON.parse(pkg.packedJson) as Manifest;
  expect(pkg.source).not.toHaveProperty('private');
  expect(packed).not.toHaveProperty('private');
  expect(packed.version).toBe(coreVersion);
  expect(packed.version).toMatch(/^0\.\d+\.\d+$/);
  expect(packed.publishConfig?.access).toBe('public');
  expect(packed.repository?.url).toBeTruthy();
  expect(packed.homepage).toBeTruthy();
  expect(packed.bugs?.url).toBeTruthy();
  for (const name of ['LICENSE', 'NOTICE'])
    expect(readFileSync(join(root, 'packages', pkg.directory, name))).toEqual(
      readFileSync(join(root, name)),
    );
});

test('release size measurements include the kit and its LangGraph consumer bundle', async () => {
  for (const directory of ['adapter-kit', 'adapter-langgraph']) {
    const result = await build({
      configFile: false,
      root,
      logLevel: 'silent',
      build: {
        write: false,
        minify: true,
        lib: {
          entry: join(root, 'packages', directory, 'dist/index.js'),
          formats: ['es'],
          fileName: directory,
        },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const code: string[] = [];
    const modules: string[] = [];
    for (const output of outputs) {
      if (!('output' in output)) throw new Error('Expected an in-memory release bundle.');
      for (const chunk of output.output) {
        if (chunk.type !== 'chunk') continue;
        code.push(chunk.code);
        modules.push(...Object.keys(chunk.modules));
      }
    }
    expect(
      modules.some((module) => module.replaceAll('\\', '/').includes('/adapter-kit/dist/')),
    ).toBe(true);
    const text = code.join('\n');
    expect(text).not.toContain('@galaxie-ai/adapter-kit');
    expect(text.length).toBeGreaterThan(0);
    console.info(
      `${directory} release bundle: ${Buffer.byteLength(text)} bytes, ${gzipSync(text).byteLength} gzip bytes (includes adapter-kit).`,
    );
  }
}, 120_000);

test('all other packages remain private', () => {
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (entry.isDirectory() && !launchPackages.includes(entry.name))
      expect(readManifest(join(root, 'packages', entry.name)).private, entry.name).toBe(true);
  }
});
