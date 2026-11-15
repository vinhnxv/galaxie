// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as runtimeInventory from '../../packages/adapter-pyodide/src/runtime-files.js';
import { discoverEntries } from '../../scripts/check-size.js';

interface Manifest {
  readonly version: string;
  readonly private?: boolean;
  readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly publishConfig?: { readonly access?: string };
  readonly repository?: {
    readonly type?: string;
    readonly url?: string;
    readonly directory?: string;
  };
  readonly homepage?: string;
  readonly bugs?: { readonly url?: string };
  readonly files?: readonly string[];
  readonly engines?: { readonly node?: string };
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
const preparedPackages = ['adapter-pyodide', 'adapter-adk', 'adapter-go'];

function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Manifest;
}

const coreVersion = readManifest(join(root, 'packages/core')).version;
const packages = [...launchPackages, ...preparedPackages].map((directory) => ({
  directory,
  group: launchPackages.includes(directory) ? 'launch' : 'prepared',
  source: readManifest(join(root, 'packages', directory)),
  entries: [] as string[],
  packedJson: '',
  tarball: '',
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
  execFileSync(process.execPath, ['scripts/build-host-config-schema.ts'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
  });
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
    pkg.tarball = tarball;
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

function missingExportTargets(manifest: Manifest, entries: readonly string[]): string[] {
  return Object.values(manifest.exports)
    .flatMap((targets) => Object.values(targets))
    .filter((target) => !entries.includes(`package/${target.replace(/^\.\//, '')}`));
}

test.each(packages)('$directory packs only distribution files and includes every export', (pkg) => {
  for (const name of ['package.json', 'README.md', 'LICENSE', 'NOTICE'])
    expect(pkg.entries).toContain(`package/${name}`);
  expect(pkg.entries.some((entry) => entry.startsWith('package/dist/'))).toBe(true);
  const manifest = JSON.parse(pkg.packedJson) as Manifest;
  expect(missingExportTargets(manifest, pkg.entries)).toEqual([]);
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
  if (pkg.group === 'launch') {
    expect(pkg.source).not.toHaveProperty('private');
    expect(packed).not.toHaveProperty('private');
    expect(packed.version).toBe(coreVersion);
  } else {
    for (const manifest of [pkg.source, packed]) {
      expect(manifest.private).toBe(true);
      expect(manifest.engines?.node).toBeTypeOf('string');
      expect(manifest.engines?.node?.trim()).not.toBe('');
      expect(manifest.repository).toEqual({
        type: 'git',
        url: 'git+https://github.com/vinhnxv/galaxie.git',
        directory: `packages/${pkg.directory}`,
      });
      expect(manifest.homepage).toBe(
        `https://github.com/vinhnxv/galaxie/tree/main/packages/${pkg.directory}#readme`,
      );
      expect(manifest.bugs?.url).toBe('https://github.com/vinhnxv/galaxie/issues');
      expect(manifest.publishConfig?.access).toBe('public');
      expect(manifest.files).toEqual(['dist', 'LICENSE', 'NOTICE']);
    }
    expect(packed.version).toBe(pkg.source.version);
  }
  expect(packed.version).toMatch(/^0\.\d+\.\d+$/);
  expect(packed.publishConfig?.access).toBe('public');
  expect(packed.repository?.url).toBeTruthy();
  expect(packed.homepage).toBeTruthy();
  expect(packed.bugs?.url).toBeTruthy();
  for (const name of ['LICENSE', 'NOTICE']) {
    expect(readFileSync(join(root, 'packages', pkg.directory, name))).toEqual(
      readFileSync(join(root, name)),
    );
    expect(execFileSync('tar', ['-xzOf', pkg.tarball, `package/${name}`])).toEqual(
      readFileSync(join(root, name)),
    );
  }
});

test.each(packages.filter((pkg) => pkg.group === 'prepared'))(
  '$directory detects a missing packed export target',
  (pkg) => {
    const manifest = JSON.parse(pkg.packedJson) as Manifest;
    expect(missingExportTargets(manifest, pkg.entries)).toEqual([]);
    expect(
      missingExportTargets(
        manifest,
        pkg.entries.filter((entry) => entry !== 'package/dist/index.js'),
      ),
    ).toEqual(['./dist/index.js']);
  },
);

test.each(packages.filter((pkg) => pkg.group === 'prepared'))(
  '$directory maps every export to dist JavaScript and declarations',
  (pkg) => {
    for (const manifest of [pkg.source, JSON.parse(pkg.packedJson) as Manifest]) {
      for (const targets of Object.values(manifest.exports)) {
        expect(targets['types']).toMatch(/^\.\/dist\/.+\.d\.ts$/);
        expect(targets['default']).toMatch(/^\.\/dist\/.+\.(?:js|mjs)$/);
      }
    }
    if (pkg.directory !== 'adapter-adk') {
      expect(pkg.entries).toContain('package/dist/worker.js');
      expect(pkg.entries).toContain('package/dist/worker.d.ts');
    }
  },
);

test('prepared packages stay outside launch and size discovery', () => {
  const entries = discoverEntries(join(root, 'packages'));
  expect(entries.length).toBeGreaterThan(0);
  for (const directory of preparedPackages) {
    expect(launchPackages).not.toContain(directory);
    expect(entries.filter(({ entry }) => entry.startsWith(`@galaxie-ai/${directory}/`))).toEqual(
      [],
    );
  }
});

test('size discovery detects prepared packages when a copy loses private status', () => {
  if (temporaryDirectory === undefined) throw new Error('Missing temporary directory.');
  const directory = join(temporaryDirectory, 'size-discovery');
  mkdirSync(directory);
  for (const pkg of packages.filter((entry) => entry.group === 'prepared')) {
    const destination = join(directory, pkg.directory);
    mkdirSync(destination);
    writeFileSync(
      join(destination, 'package.json'),
      JSON.stringify({ ...pkg.source, private: false }),
    );
  }
  expect(discoverEntries(directory).map(({ entry }) => entry)).toEqual([
    '@galaxie-ai/adapter-adk/.',
    '@galaxie-ai/adapter-go/.',
    '@galaxie-ai/adapter-go/worker',
    '@galaxie-ai/adapter-pyodide/.',
    '@galaxie-ai/adapter-pyodide/runtime-files',
    '@galaxie-ai/adapter-pyodide/worker',
  ]);
});

test('the packed runtime-files module exposes the worker inventories', () => {
  const pkg = packages.find((entry) => entry.directory === 'adapter-pyodide');
  if (pkg === undefined || temporaryDirectory === undefined)
    throw new Error('Missing packed adapter.');
  const manifest = JSON.parse(pkg.packedJson) as Manifest;
  expect(manifest.exports['./runtime-files']).toEqual({
    types: './dist/runtime-files.d.ts',
    default: './dist/runtime-files.js',
  });
  expect(pkg.entries).toContain('package/dist/runtime-files.d.ts');
  expect(missingExportTargets(manifest, pkg.entries)).toEqual([]);
  expect(
    missingExportTargets(
      manifest,
      pkg.entries.filter((entry) => entry !== 'package/dist/runtime-files.js'),
    ),
  ).toEqual(['./dist/runtime-files.js']);
  const file = join(temporaryDirectory, 'runtime-files.mjs');
  writeFileSync(file, execFileSync('tar', ['-xzOf', pkg.tarball, 'package/dist/runtime-files.js']));
  const packed = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        'const inventory = await import(process.argv[1]); process.stdout.write(JSON.stringify(inventory));',
        pathToFileURL(file).href,
      ],
      { encoding: 'utf8' },
    ),
  ) as typeof runtimeInventory;
  expect(Object.keys(packed).sort()).toEqual(['lockedWheels', 'runtimeFiles']);
  expect(packed.lockedWheels).toEqual(runtimeInventory.lockedWheels);
  expect(packed.runtimeFiles).toEqual(runtimeInventory.runtimeFiles);
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
