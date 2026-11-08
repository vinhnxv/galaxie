// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type AgentDefinition, createManifest } from '@galaxie-ai/core';
import { expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';
import { verifyManifest, writeManifest } from '../../scripts/build-manifest.js';

const entry = 'export const value = 1;\n';
const skill = '# Practice\n';
const lockfile = 'lockfileVersion: 9.0\n';
const definition: AgentDefinition = {
  id: 'tests.fixture',
  version: '1.0.0',
  executor: 'fake',
  input: z.object({ id: z.string() }),
  skills: ['./skills/SKILL.md'],
};

function fixture(): {
  root: string;
  packageDir: string;
  definition: AgentDefinition;
  createManifest: typeof createManifest;
} {
  const root = mkdtempSync(join(tmpdir(), 'galaxie-manifest-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const packageDir = join(root, 'agent');
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  mkdirSync(join(packageDir, 'skills'));
  writeFileSync(join(root, 'pnpm-lock.yaml'), lockfile);
  writeFileSync(join(packageDir, 'dist/index.js'), entry);
  writeFileSync(join(packageDir, 'dist/chunk.js'), 'export const chunk = true;\n');
  writeFileSync(join(packageDir, 'skills/SKILL.md'), skill);
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@tests/fixture',
      version: '1.0.0',
      type: 'module',
      files: ['dist'],
      galaxie: {
        definition: './dist/index.js',
        export: 'fixtureDefinition',
        out: './dist/galaxie',
      },
    }),
  );
  return { root, packageDir, definition, createManifest };
}

function output(packageDir: string): Record<string, string> {
  const out = join(packageDir, 'dist/galaxie');
  return Object.fromEntries(
    readdirSync(out, { recursive: true, withFileTypes: true })
      .filter((item) => item.isFile())
      .map((item) => [
        join(item.parentPath, item.name).slice(out.length),
        readFileSync(join(item.parentPath, item.name), 'utf8'),
      ]),
  );
}

test('writes stable JSON, hashes the shipped inventory and removes stale output', () => {
  const options = fixture();
  writeManifest(options);
  const before = output(options.packageDir);
  const manifest = JSON.parse(
    readFileSync(join(options.packageDir, 'dist/galaxie/manifest.json'), 'utf8'),
  );
  expect(manifest.integrity).toEqual({
    entry: 'sha256-XY9l0ndOIGvJ96ekrTnKLcVjtcMeRqtX70h0lhI3zik=',
    files: {
      './dist/chunk.js': 'sha256-+OlHS9qU+na0YgtgeHG6Bihu9u3/+miGYUtjgyZc1ww=',
      './dist/index.js': 'sha256-XY9l0ndOIGvJ96ekrTnKLcVjtcMeRqtX70h0lhI3zik=',
      './package.json': 'sha256-h+bZRPPB7/9zDTvRGUjAP+m1Pf+1Gsh4U/GdgMHrDiI=',
      './skills/SKILL.md': 'sha256-iySuepU2kErcZ2VvP93reCY4ZuBjqnyug+hXRB27FMk=',
    },
    lockfile: 'sha256-yY0r2dC8c5pZN666br/LaaLH7huujnWYCNWW7zjZwrU=',
  });
  for (const text of Object.values(before))
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  writeFileSync(join(options.packageDir, 'dist/galaxie/stale.json'), '{}');
  writeManifest(options);
  expect(output(options.packageDir)).toEqual(before);
  expect(() => verifyManifest(options)).not.toThrow();
  expect(output(options.packageDir)).toEqual(before);
});

test.each([
  ['changed dist file', 'dist/chunk.js', 'changed'],
  ['new dist file', 'dist/new.js', 'new'],
  ['missing dist file', 'dist/chunk.js', undefined],
  ['changed entry', 'dist/index.js', 'changed'],
  ['changed skill', 'skills/SKILL.md', 'changed'],
  ['missing skill', 'skills/SKILL.md', undefined],
  ['changed lockfile', '../pnpm-lock.yaml', 'changed'],
  ['changed schema', 'dist/galaxie/schemas/input.json', 'changed'],
  ['missing schema', 'dist/galaxie/schemas/input.json', undefined],
  ['new output file', 'dist/galaxie/new.json', '{}'],
  ['changed manifest', 'dist/galaxie/manifest.json', 'private-file-content'],
])('verification rejects %s without writing', (_name, path, content) => {
  const options = fixture();
  writeManifest(options);
  const target = join(options.packageDir, path);
  if (content === undefined) rmSync(target);
  else writeFileSync(target, content);
  const before = output(options.packageDir);
  try {
    verifyManifest(options);
    expect.unreachable('Expected verification failure.');
  } catch (error) {
    expect((error as Error).message).toContain(path.replace('../', ''));
    expect((error as Error).message).not.toContain('private-file-content');
    expect(error).not.toHaveProperty('cause');
  }
  expect(output(options.packageDir)).toEqual(before);
});

test('regenerates schemas during verification', () => {
  const options = fixture();
  writeManifest(options);
  expect(() =>
    verifyManifest({ ...options, definition: { ...definition, input: z.number() } }),
  ).toThrowError('./dist/galaxie/schemas/input.json');
});

test('checks version, required files and fixed failures before deleting output', () => {
  const options = fixture();
  writeManifest(options);
  const before = output(options.packageDir);
  expect(() =>
    writeManifest({ ...options, definition: { ...definition, version: '2.0.0' } }),
  ).toThrowError('The definition version must match the package version.');
  rmSync(join(options.packageDir, 'dist/index.js'));
  expect(() => writeManifest(options)).toThrowError('./dist/index.js');
  expect(output(options.packageDir)).toEqual(before);
  expect(() =>
    writeManifest({
      ...options,
      createManifest: () => {
        throw new Error('private-file-content');
      },
    }),
  ).toThrowError('Manifest operation failed.');
});

test.each([
  './dist',
  './',
  './../outside',
  './dist\\outside',
  './https:outside',
  './unshipped/out',
])('rejects invalid output containment before mutation', (out) => {
  const options = fixture();
  const path = join(options.packageDir, 'package.json');
  const metadata = JSON.parse(readFileSync(path, 'utf8'));
  metadata.galaxie.out = out;
  writeFileSync(path, JSON.stringify(metadata));
  expect(() => writeManifest(options)).toThrowError('The package paths are invalid.');
  expect(readFileSync(join(options.packageDir, 'dist/index.js'), 'utf8')).toBe(entry);
});

test('rejects symlinked output, output ancestors and inventory files', () => {
  const options = fixture();
  const external = join(options.root, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'sentinel'), 'unchanged');
  symlinkSync(external, join(options.packageDir, 'dist/galaxie'));
  expect(() => writeManifest(options)).toThrowError('The package paths are invalid.');
  rmSync(join(options.packageDir, 'dist/galaxie'));
  symlinkSync(join(external, 'sentinel'), join(options.packageDir, 'dist/linked.js'));
  expect(() => writeManifest(options)).toThrowError('The package paths are invalid.');
  rmSync(join(options.packageDir, 'dist/linked.js'));
  rmSync(join(options.packageDir, 'dist'), { recursive: true });
  symlinkSync(external, join(options.packageDir, 'dist'));
  expect(() => writeManifest(options)).toThrowError('The package paths are invalid.');
  expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('unchanged');
  expect(readdirSync(external)).toEqual(['sentinel']);
});

test('rejects schema traversal and skills inside output before deleting anything', () => {
  const options = fixture();
  writeManifest(options);
  const before = output(options.packageDir);
  expect(() =>
    writeManifest({
      ...options,
      createManifest: (value, entry) => ({
        ...createManifest(value, entry),
        schemas: { './../outside.json': {} },
      }),
    }),
  ).toThrowError('The package paths are invalid.');
  expect(() =>
    writeManifest({
      ...options,
      definition: { ...definition, skills: ['./dist/galaxie/manifest.json'] },
    }),
  ).toThrowError('The package paths are invalid.');
  expect(output(options.packageDir)).toEqual(before);
});

test('CLI errors discard parser and host messages', () => {
  const options = fixture();
  writeFileSync(join(options.packageDir, 'package.json'), 'private-file-content');
  const script = fileURLToPath(new URL('../../scripts/build-manifest.ts', import.meta.url));
  const result = spawnSync(process.execPath, [script, options.packageDir], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('Manifest operation failed.\n');
});

test('importing the script has no CLI side effects', () => {
  const script = fileURLToPath(new URL('../../scripts/build-manifest.ts', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(script).href)});`],
    { encoding: 'utf8' },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});

test.each(['manifest.json', 'schemas/input.json'])(
  'verification compares exact bytes in %s',
  (path) => {
    const options = fixture();
    const unicodeDefinition = {
      ...definition,
      id: 'tests.\uFFFD',
      input: z.string().describe('\uFFFD'),
    };
    writeManifest({ ...options, definition: unicodeDefinition });
    const target = join(options.packageDir, 'dist/galaxie', path);
    const original = readFileSync(target);
    const index = original.indexOf(Buffer.from('\uFFFD'));
    expect(index).toBeGreaterThanOrEqual(0);
    const corrupt = Buffer.concat([
      original.subarray(0, index),
      Buffer.from([0xff]),
      original.subarray(index + 3),
    ]);
    expect(corrupt.toString('utf8') === original.toString('utf8')).toBe(true);
    writeFileSync(target, corrupt);
    expect(() => verifyManifest({ ...options, definition: unicodeDefinition })).toThrowError(
      `./dist/galaxie/${path}`,
    );
    expect(readFileSync(target).equals(corrupt)).toBe(true);
  },
);

test('rejects entry and skill case aliases inside output before deleting them', (context) => {
  for (const kind of ['entry', 'skill']) {
    const options = fixture();
    if (!existsSync(join(options.packageDir, 'DIST'))) context.skip();
    const out = join(options.packageDir, 'dist/galaxie');
    mkdirSync(out);
    writeFileSync(join(out, 'kept.js'), entry);
    const metadataPath = join(options.packageDir, 'package.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (kind === 'entry') metadata.galaxie.definition = './dist/GALAXIE/kept.js';
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const input =
      kind === 'skill' ? { ...definition, skills: ['./dist/GALAXIE/kept.js'] } : definition;
    expect(() => writeManifest({ ...options, definition: input })).toThrowError(
      'The package paths are invalid.',
    );
    expect(readFileSync(join(out, 'kept.js'), 'utf8')).toBe(entry);
  }
});

test('excludes output directory case aliases from the shipped inventory', (context) => {
  const options = fixture();
  if (!existsSync(join(options.packageDir, 'DIST'))) context.skip();
  writeManifest(options);
  const path = join(options.packageDir, 'package.json');
  const metadata = JSON.parse(readFileSync(path, 'utf8'));
  metadata.files.push('dist/GALAXIE');
  writeFileSync(path, JSON.stringify(metadata));
  writeManifest(options);
  const manifest = JSON.parse(
    readFileSync(join(options.packageDir, 'dist/galaxie/manifest.json'), 'utf8'),
  );
  expect(
    Object.keys(manifest.integrity.files).some((file) =>
      file.toLowerCase().startsWith('./dist/galaxie/'),
    ),
  ).toBe(false);
  expect(() => verifyManifest(options)).not.toThrow();
});

test('never overwrites schema files that alias on the destination filesystem', () => {
  const options = fixture();
  const request = { kind: 'read', input: z.string(), output: z.boolean() } as const;
  const input: AgentDefinition = {
    ...definition,
    capabilities: {
      required: {
        'Z@1': request,
        'z@1': { ...request, input: z.number() },
      },
    },
  };
  if (existsSync(join(options.packageDir, 'DIST'))) {
    expect(() => writeManifest({ ...options, definition: input })).toThrowError(
      'Manifest operation failed.',
    );
  } else {
    writeManifest({ ...options, definition: input });
    expect(() => verifyManifest({ ...options, definition: input })).not.toThrow();
  }
});

test('verification rejects aliased artifact names even when their bytes match', (context) => {
  const options = fixture();
  if (!existsSync(join(options.packageDir, 'DIST'))) context.skip();
  const request = { kind: 'read', input: z.string(), output: z.boolean() } as const;
  const single = { ...definition, capabilities: { required: { 'z@1': request } } };
  const dual = { ...definition, capabilities: { required: { 'Z@1': request, 'z@1': request } } };
  writeManifest({ ...options, definition: single });
  const path = join(options.packageDir, 'dist/galaxie/manifest.json');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(
    path,
    `${JSON.stringify({ ...createManifest(dual, { entry: './dist/index.js' }).manifest, integrity: saved.integrity }, null, 2)}\n`,
  );
  expect(() => verifyManifest({ ...options, definition: dual })).toThrowError(
    './dist/galaxie/schemas/Z@1.input.json',
  );
});

test('hashes the nearest lockfile and ignores changes to a farther ancestor', () => {
  const options = fixture();
  const nearest = join(options.packageDir, 'pnpm-lock.yaml');
  writeFileSync(nearest, 'nearest-lockfile\n');
  writeManifest(options);
  writeFileSync(join(options.root, 'pnpm-lock.yaml'), 'farther-lockfile-changed\n');
  expect(() => verifyManifest(options)).not.toThrow();
  writeFileSync(nearest, 'nearest-lockfile-changed\n');
  expect(() => verifyManifest(options)).toThrowError(nearest);
});
