// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { expect, onTestFinished, test } from 'vitest';
import { run } from '../src/main.js';
import { resolveTarballs } from '../src/packages.js';
import { readTarballManifest } from '../src/tarball.js';

const names = [
  'ui-protocol',
  'core',
  'adapter-kit',
  'adapter-langgraph',
  'models',
  'storage-indexeddb',
  'react',
] as const;
const templatesRoot = fileURLToPath(new URL('../../../templates', import.meta.url));

async function archive(
  packed: string,
  name: string,
  version: string,
  metadata: unknown = { name: `@galaxie-ai/${name}`, version },
): Promise<void> {
  const source = await mkdtemp(join(tmpdir(), 'galaxie-tar-source-'));
  try {
    await mkdir(join(source, 'package'));
    await writeFile(join(source, 'package/package.json'), JSON.stringify(metadata) ?? 'null');
    execFileSync('tar', [
      '--format=ustar',
      '-czf',
      join(packed, `galaxie-ai-${name}-${version}.tgz`),
      '-C',
      source,
      'package',
    ]);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

async function fixture(): Promise<{ root: string; packed: string }> {
  const root = await mkdtemp(join(tmpdir(), 'galaxie-tarballs-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const packed = join(root, 'packed');
  await mkdir(packed);
  for (const name of names) await archive(packed, name, '0.1.0');
  return { root, packed };
}

function tarEntry(path: string, bytes: Buffer, type = '0', prefix = ''): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100);
  header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124, 12);
  header.write(type, 156, 1);
  header.write('ustar\0', 257, 6);
  header.write(prefix, 345, 155);
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}

test.each([
  'manifest size',
  'symlink',
  'trailing garbage',
  'later trailing garbage',
  'missing end marker',
  'foreign prefix',
  'x',
  'g',
  'L',
  'K',
  'decompressed size',
] as const)('tarball reader rejects %s with a valid archive control', async (problem) => {
  const root = await mkdtemp(join(tmpdir(), 'galaxie-tar-reader-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.tgz');
  const metadata = { name: '@galaxie-ai/core', version: '0.1.0' };
  const entry = tarEntry('package.json', Buffer.from(JSON.stringify(metadata)), '0', 'package');
  const valid = Buffer.concat([entry, Buffer.alloc(1024)]);
  await writeFile(path, gzipSync(valid));
  expect(await readTarballManifest(path, metadata.name)).toEqual(metadata);
  let invalid: Buffer = valid;
  if (problem === 'manifest size')
    invalid = Buffer.concat([
      tarEntry(
        'package/package.json',
        Buffer.from(JSON.stringify({ data: 'a'.repeat(1_048_576) })),
      ),
      Buffer.alloc(1024),
    ]);
  if (problem === 'symlink')
    invalid = Buffer.concat([
      tarEntry('package/package.json', Buffer.from(JSON.stringify(metadata)), '2'),
      Buffer.alloc(1024),
    ]);
  if (problem === 'trailing garbage') invalid = Buffer.concat([valid, Buffer.from('garbage')]);
  if (problem === 'later trailing garbage')
    invalid = Buffer.concat([valid, Buffer.alloc(64 * 1024), Buffer.from('garbage')]);
  if (problem === 'missing end marker') invalid = entry;
  if (problem === 'foreign prefix')
    invalid = Buffer.concat([
      tarEntry('package/package.json', Buffer.from(JSON.stringify(metadata)), '0', 'other'),
      Buffer.alloc(1024),
    ]);
  if (['x', 'g', 'L', 'K'].includes(problem))
    invalid = Buffer.concat([
      tarEntry('override', Buffer.from('package/package.json\0'), problem),
      valid,
    ]);
  await writeFile(path, gzipSync(invalid));
  await expect(
    readTarballManifest(
      path,
      metadata.name,
      problem === 'decompressed size' ? valid.length - 1 : undefined,
    ),
  ).rejects.toThrow('@galaxie-ai/core: could not read tarball package/package.json.');
  if (problem === 'decompressed size')
    expect(await readTarballManifest(path, metadata.name, valid.length)).toEqual(metadata);
});

test('the npm CLI emits fixed file dependency specs and all seven overrides', async () => {
  const { root, packed } = await fixture();
  const resolved = await resolveTarballs(packed);
  expect(Object.fromEntries(resolved)).toEqual(
    Object.fromEntries(
      names.map((name) => [`@galaxie-ai/${name}`, join(packed, `galaxie-ai-${name}-0.1.0.tgz`)]),
    ),
  );
  const stdout = new PassThrough();
  let notice = '';
  stdout.on('data', (bytes: Buffer) => {
    notice += bytes.toString();
  });
  expect(
    await run(['my-app', 'browser-only', 'langgraph-js', '--no-install'], {
      cwd: root,
      templatesRoot,
      stdout,
      stderr: new PassThrough(),
      env: { GALAXIE_CREATE_PACKAGE_DIR: packed, npm_config_user_agent: 'npm/12' },
    }),
  ).toBe(0);
  const manifest = JSON.parse(await readFile(join(root, 'my-app/package.json'), 'utf8'));
  expect(manifest.overrides).toEqual({
    '@galaxie-ai/ui-protocol': `file:${packed}/galaxie-ai-ui-protocol-0.1.0.tgz`,
    '@galaxie-ai/core': `file:${packed}/galaxie-ai-core-0.1.0.tgz`,
    '@galaxie-ai/adapter-kit': `file:${packed}/galaxie-ai-adapter-kit-0.1.0.tgz`,
    '@galaxie-ai/adapter-langgraph': `file:${packed}/galaxie-ai-adapter-langgraph-0.1.0.tgz`,
    '@galaxie-ai/models': `file:${packed}/galaxie-ai-models-0.1.0.tgz`,
    '@galaxie-ai/storage-indexeddb': `file:${packed}/galaxie-ai-storage-indexeddb-0.1.0.tgz`,
    '@galaxie-ai/react': `file:${packed}/galaxie-ai-react-0.1.0.tgz`,
  });
  expect(
    Object.fromEntries(
      Object.entries(manifest.dependencies).filter(([name]) => name.startsWith('@galaxie-ai/')),
    ),
  ).toEqual({
    '@galaxie-ai/adapter-langgraph': `file:${packed}/galaxie-ai-adapter-langgraph-0.1.0.tgz`,
    '@galaxie-ai/core': `file:${packed}/galaxie-ai-core-0.1.0.tgz`,
    '@galaxie-ai/models': `file:${packed}/galaxie-ai-models-0.1.0.tgz`,
    '@galaxie-ai/react': `file:${packed}/galaxie-ai-react-0.1.0.tgz`,
    '@galaxie-ai/storage-indexeddb': `file:${packed}/galaxie-ai-storage-indexeddb-0.1.0.tgz`,
  });
  expect(manifest.dependencies.react).toBe('19.3.1');
  expect(notice).toContain(
    'Note: Using local tarball file: dependencies from GALAXIE_CREATE_PACKAGE_DIR.\n',
  );
});

test.each(['empty', 'relative', 'absent', 'missing', 'duplicate', 'symlink'] as const)(
  'tarball directory %s fails before any project write, with a valid-directory control',
  async (kind) => {
    const { root, packed } = await fixture();
    expect((await resolveTarballs(packed)).size).toBe(7);
    let directory = packed;
    if (kind === 'empty') directory = '';
    if (kind === 'relative') directory = 'packed';
    if (kind === 'absent') directory = join(root, 'absent');
    if (kind === 'missing') await rm(join(packed, 'galaxie-ai-core-0.1.0.tgz'));
    if (kind === 'duplicate') await writeFile(join(packed, 'galaxie-ai-core-0.1.1.tgz'), 'fixture');
    if (kind === 'symlink') {
      await rm(join(packed, 'galaxie-ai-core-0.1.0.tgz'));
      await symlink(
        join(packed, 'galaxie-ai-react-0.1.0.tgz'),
        join(packed, 'galaxie-ai-core-0.1.0.tgz'),
      );
    }
    const stderr = new PassThrough();
    let errors = '';
    stderr.on('data', (bytes: Buffer) => {
      errors += bytes.toString();
    });
    expect(
      await run(['my-app', 'browser-only', 'langgraph-js', '--no-install'], {
        cwd: root,
        templatesRoot,
        stdout: new PassThrough(),
        stderr,
        env: { GALAXIE_CREATE_PACKAGE_DIR: directory },
      }),
    ).toBe(1);
    expect(existsSync(join(root, 'my-app'))).toBe(false);
    expect(errors).toContain('tarball');
    expect(await readdir(root)).toEqual(['packed']);
  },
);

test.each(['pnpm', 'yarn'])(
  'tarball mode refuses unproven %s installs before writing',
  async (manager) => {
    const { root, packed } = await fixture();
    const stderr = new PassThrough();
    let errors = '';
    stderr.on('data', (bytes: Buffer) => {
      errors += bytes.toString();
    });
    expect(
      await run(['my-app', 'browser-only', 'langgraph-js', '--no-install'], {
        cwd: root,
        templatesRoot,
        stdout: new PassThrough(),
        stderr,
        env: { GALAXIE_CREATE_PACKAGE_DIR: packed, npm_config_user_agent: `${manager}/1` },
      }),
    ).toBe(1);
    expect(errors).toContain('Tarball mode supports npm only');
    expect(existsSync(join(root, 'my-app'))).toBe(false);
  },
);

test('ADK tarballs add one adapter without changing the seven launch inventory', async () => {
  const { root, packed } = await fixture();
  await archive(packed, 'adapter-adk', '0.0.0');
  expect((await resolveTarballs(packed)).size).toBe(7);
  expect((await resolveTarballs(packed, 'adk-js')).size).toBe(8);
  expect(
    await run(['adk-app', 'browser-only', 'adk-js', '--no-install'], {
      cwd: root,
      templatesRoot,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      env: { GALAXIE_CREATE_PACKAGE_DIR: packed, npm_config_user_agent: 'npm/12' },
    }),
  ).toBe(0);
  const manifest = JSON.parse(await readFile(join(root, 'adk-app/package.json'), 'utf8'));
  expect(manifest.overrides).toEqual(
    Object.fromEntries(
      [...names, 'adapter-adk'].map((name) => [
        '@galaxie-ai/' + name,
        `file:${packed}/galaxie-ai-${name}-${name === 'adapter-adk' ? '0.0.0' : '0.1.0'}.tgz`,
      ]),
    ),
  );
  expect(
    Object.fromEntries(
      Object.entries(manifest.dependencies).filter(([name]) => name.startsWith('@galaxie-ai/')),
    ),
  ).toEqual({
    '@galaxie-ai/adapter-adk': `file:${packed}/galaxie-ai-adapter-adk-0.0.0.tgz`,
    '@galaxie-ai/core': `file:${packed}/galaxie-ai-core-0.1.0.tgz`,
    '@galaxie-ai/models': `file:${packed}/galaxie-ai-models-0.1.0.tgz`,
    '@galaxie-ai/react': `file:${packed}/galaxie-ai-react-0.1.0.tgz`,
    '@galaxie-ai/storage-indexeddb': `file:${packed}/galaxie-ai-storage-indexeddb-0.1.0.tgz`,
  });
});

test.each(['missing', 'duplicate'])(
  'an %s ADK tarball fails before writing only for ADK',
  async (problem) => {
    const { root, packed } = await fixture();
    if (problem === 'duplicate') {
      await archive(packed, 'adapter-adk', '0.0.0');
      await writeFile(join(packed, 'galaxie-ai-adapter-adk-0.0.1.tgz'), 'fixture');
    }
    expect((await resolveTarballs(packed)).size).toBe(7);
    await expect(resolveTarballs(packed, 'adk-js')).rejects.toThrow('@galaxie-ai/adapter-adk');
    expect(
      await run(['adk-app', 'gateway', 'adk-js', '--no-install'], {
        cwd: root,
        templatesRoot,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        env: { GALAXIE_CREATE_PACKAGE_DIR: packed, npm_config_user_agent: 'npm/12' },
      }),
    ).toBe(1);
    expect(existsSync(join(root, 'adk-app'))).toBe(false);
  },
);

test.each(['browser-only', 'gateway'])(
  'ADK Go %s rewrites both private packages and all nine overrides',
  async (kind) => {
    const { root, packed } = await fixture();
    for (const name of ['adapter-go', 'starter-go']) await archive(packed, name, '0.0.0');
    expect((await resolveTarballs(packed)).size).toBe(7);
    expect((await resolveTarballs(packed, 'adk-go')).size).toBe(9);
    expect(
      await run(['go-app', kind, 'adk-go', '--no-install'], {
        cwd: root,
        templatesRoot,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        env: { GALAXIE_CREATE_PACKAGE_DIR: packed, npm_config_user_agent: 'npm/12' },
      }),
    ).toBe(0);
    const manifest = JSON.parse(await readFile(join(root, 'go-app/package.json'), 'utf8'));
    expect(manifest.overrides).toEqual(
      Object.fromEntries(
        [...names, 'adapter-go', 'starter-go'].map((name) => [
          '@galaxie-ai/' + name,
          `file:${packed}/galaxie-ai-${name}-${name.endsWith('-go') ? '0.0.0' : '0.1.0'}.tgz`,
        ]),
      ),
    );
    for (const name of ['adapter-go', 'starter-go'])
      expect(manifest.dependencies['@galaxie-ai/' + name]).toBe(
        `file:${packed}/galaxie-ai-${name}-0.0.0.tgz`,
      );
  },
);

test.each(['adapter-go', 'starter-go'])(
  'ADK Go requires exactly one %s tarball before writing',
  async (name) => {
    const { root, packed } = await fixture();
    for (const other of ['adapter-go', 'starter-go']) await archive(packed, other, '0.0.0');
    const target = join(packed, `galaxie-ai-${name}-0.0.0.tgz`);
    await rm(target);
    await expect(resolveTarballs(packed, 'adk-go')).rejects.toThrow('@galaxie-ai/' + name);
    await archive(packed, name, '0.0.0');
    expect((await resolveTarballs(packed, 'adk-go')).size).toBe(9);
    await writeFile(join(packed, `galaxie-ai-${name}-0.0.1.tgz`), 'fixture');
    await expect(resolveTarballs(packed, 'adk-go')).rejects.toThrow('@galaxie-ai/' + name);
    expect(
      await run(['go-app', 'browser-only', 'adk-go', '--no-install'], {
        cwd: root,
        templatesRoot,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        env: { GALAXIE_CREATE_PACKAGE_DIR: packed },
      }),
    ).toBe(1);
    expect(existsSync(join(root, 'go-app'))).toBe(false);
  },
);

test.each(['browser-only', 'gateway'])(
  'LangGraph Python %s rewrites both private packages and all nine overrides',
  async (kind) => {
    const { root, packed } = await fixture();
    for (const name of ['adapter-pyodide', 'starter-python']) await archive(packed, name, '0.0.0');
    expect((await resolveTarballs(packed)).size).toBe(7);
    expect((await resolveTarballs(packed, 'langgraph-python')).size).toBe(9);
    expect(
      await run(['python-app', kind, 'langgraph-python', '--no-install'], {
        cwd: root,
        templatesRoot,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        env: { GALAXIE_CREATE_PACKAGE_DIR: packed, npm_config_user_agent: 'npm/12' },
      }),
    ).toBe(0);
    const manifest = JSON.parse(await readFile(join(root, 'python-app/package.json'), 'utf8'));
    expect(manifest.overrides).toEqual(
      Object.fromEntries(
        [...names, 'adapter-pyodide', 'starter-python'].map((name) => [
          '@galaxie-ai/' + name,
          `file:${packed}/galaxie-ai-${name}-${['adapter-pyodide', 'starter-python'].includes(name) ? '0.0.0' : '0.1.0'}.tgz`,
        ]),
      ),
    );
    for (const name of ['adapter-pyodide', 'starter-python'])
      expect(manifest.dependencies['@galaxie-ai/' + name]).toBe(
        `file:${packed}/galaxie-ai-${name}-0.0.0.tgz`,
      );
  },
);

test.each(['adapter-pyodide', 'starter-python'])(
  'LangGraph Python requires exactly one %s tarball before writing',
  async (name) => {
    const { root, packed } = await fixture();
    for (const other of ['adapter-pyodide', 'starter-python'])
      await archive(packed, other, '0.0.0');
    const target = join(packed, `galaxie-ai-${name}-0.0.0.tgz`);
    await rm(target);
    await expect(resolveTarballs(packed, 'langgraph-python')).rejects.toThrow(
      '@galaxie-ai/' + name,
    );
    await archive(packed, name, '0.0.0');
    expect((await resolveTarballs(packed, 'langgraph-python')).size).toBe(9);
    await writeFile(join(packed, `galaxie-ai-${name}-0.0.1.tgz`), 'fixture');
    await expect(resolveTarballs(packed, 'langgraph-python')).rejects.toThrow(
      '@galaxie-ai/' + name,
    );
    expect(
      await run(['python-app', 'browser-only', 'langgraph-python', '--no-install'], {
        cwd: root,
        templatesRoot,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        env: { GALAXIE_CREATE_PACKAGE_DIR: packed },
      }),
    ).toBe(1);
    expect(existsSync(join(root, 'python-app'))).toBe(false);
  },
);

test.each([
  ['name', { name: '@galaxie-ai/react', version: '0.1.0' }],
  ['version', { name: '@galaxie-ai/core', version: '9.9.9' }],
])('tarball metadata %s mismatch is named before writing', async (field, metadata) => {
  const { root, packed } = await fixture();
  await archive(packed, 'core', '0.1.0', metadata);
  const stderr = new PassThrough();
  let errors = '';
  stderr.on('data', (bytes: Buffer) => {
    errors += bytes.toString();
  });
  expect(
    await run(['my-app', 'browser-only', 'langgraph-js', '--no-install'], {
      cwd: root,
      templatesRoot,
      stdout: new PassThrough(),
      stderr,
      env: { GALAXIE_CREATE_PACKAGE_DIR: packed, npm_config_user_agent: 'npm/12' },
    }),
  ).toBe(1);
  expect(errors).toContain(`@galaxie-ai/core: tarball package.json ${field} mismatch`);
  expect(existsSync(join(root, 'my-app'))).toBe(false);
});

test('an invalid archive names the package and required metadata', async () => {
  const { packed } = await fixture();
  await writeFile(join(packed, 'galaxie-ai-core-0.1.0.tgz'), 'invalid');
  await expect(resolveTarballs(packed)).rejects.toThrow(
    '@galaxie-ai/core: could not read tarball package/package.json',
  );
});

test.each([null, [], 'not an object'])(
  'tarball manifest must be an object: %j',
  async (metadata) => {
    const { packed } = await fixture();
    await archive(packed, 'core', '0.1.0', metadata);
    await expect(resolveTarballs(packed)).rejects.toThrow(
      '@galaxie-ai/core: could not read tarball package/package.json',
    );
  },
);

test.each(['duplicate', 'truncated'] as const)(
  'a %s archive cannot replace checked metadata or hide a broken payload',
  async (problem) => {
    const { root, packed } = await fixture();
    const source = join(root, 'archive-source');
    await mkdir(join(source, 'package'), { recursive: true });
    const manifest = join(source, 'package/package.json');
    const tar = join(root, 'core.tar');
    await writeFile(manifest, JSON.stringify({ name: '@galaxie-ai/core', version: '0.1.0' }));
    await writeFile(join(source, 'package/payload.bin'), randomBytes(256 * 1024));
    execFileSync('tar', [
      '--format=ustar',
      '-cf',
      tar,
      '-C',
      source,
      'package/package.json',
      'package/payload.bin',
    ]);
    if (problem === 'duplicate') {
      await writeFile(manifest, JSON.stringify({ name: '@galaxie-ai/core', version: '9.9.9' }));
      execFileSync('tar', ['-rf', tar, '-C', source, 'package/package.json']);
    }
    const compressed = gzipSync(await readFile(tar));
    await writeFile(
      join(packed, 'galaxie-ai-core-0.1.0.tgz'),
      problem === 'truncated' ? compressed.subarray(0, compressed.length - 16) : compressed,
    );
    const stderr = new PassThrough();
    let errors = '';
    stderr.on('data', (bytes: Buffer) => {
      errors += bytes.toString();
    });
    expect(
      await run(['my-app', 'browser-only', 'langgraph-js', '--no-install'], {
        cwd: root,
        templatesRoot,
        stdout: new PassThrough(),
        stderr,
        env: { GALAXIE_CREATE_PACKAGE_DIR: packed, npm_config_user_agent: 'npm/12' },
      }),
    ).toBe(1);
    expect(errors).toContain(
      problem === 'duplicate'
        ? '@galaxie-ai/core: tarball contains more than one package/package.json'
        : '@galaxie-ai/core: could not read tarball package/package.json',
    );
    expect(existsSync(join(root, 'my-app'))).toBe(false);
  },
);
