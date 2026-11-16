// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';
import { run } from '../src/main.js';
import { resolveTarballs } from '../src/packages.js';

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

async function fixture(): Promise<{ root: string; packed: string }> {
  const root = await mkdtemp(join(tmpdir(), 'galaxie-tarballs-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const packed = join(root, 'packed');
  await mkdir(packed);
  for (const name of names)
    await writeFile(join(packed, `galaxie-ai-${name}-0.1.0.tgz`), 'fixture');
  return { root, packed };
}

test('the npm CLI emits fixed file dependency specs and all seven overrides', async () => {
  const { root, packed } = await fixture();
  const resolved = await resolveTarballs(packed);
  expect(Object.fromEntries(resolved)).toEqual(
    Object.fromEntries(
      names.map((name) => [`@galaxie-ai/${name}`, join(packed, `galaxie-ai-${name}-0.1.0.tgz`)]),
    ),
  );
  expect(
    await run(['my-app', 'browser-only', 'langgraph-js', '--no-install'], {
      cwd: root,
      templatesRoot,
      stdout: new PassThrough(),
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
  await writeFile(join(packed, 'galaxie-ai-adapter-adk-0.0.0.tgz'), 'fixture');
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
      await writeFile(join(packed, 'galaxie-ai-adapter-adk-0.0.0.tgz'), 'fixture');
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
    for (const name of ['adapter-go', 'starter-go'])
      await writeFile(join(packed, `galaxie-ai-${name}-0.0.0.tgz`), 'fixture');
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
    for (const other of ['adapter-go', 'starter-go'])
      await writeFile(join(packed, `galaxie-ai-${other}-0.0.0.tgz`), 'fixture');
    const target = join(packed, `galaxie-ai-${name}-0.0.0.tgz`);
    await rm(target);
    await expect(resolveTarballs(packed, 'adk-go')).rejects.toThrow('@galaxie-ai/' + name);
    await writeFile(target, 'fixture');
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
    for (const name of ['adapter-pyodide', 'starter-python'])
      await writeFile(join(packed, `galaxie-ai-${name}-0.0.0.tgz`), 'fixture');
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
      await writeFile(join(packed, `galaxie-ai-${other}-0.0.0.tgz`), 'fixture');
    const target = join(packed, `galaxie-ai-${name}-0.0.0.tgz`);
    await rm(target);
    await expect(resolveTarballs(packed, 'langgraph-python')).rejects.toThrow(
      '@galaxie-ai/' + name,
    );
    await writeFile(target, 'fixture');
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
