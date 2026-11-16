// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  buildEnvironment,
  buildSettings,
  checkBuildSettings,
} from '../../packages/starter-go/src/build-env.js';
import { hashTree, sourceHash } from '../../packages/starter-go/src/source-hash.js';

const temporary: string[] = [];
async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'galaxie-starter-source-'));
  temporary.push(dir);
  await writeFile(join(dir, 'main.go'), 'package main\n');
  return dir;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
test('source identity includes bytes, paths, additions, version and module source', async () => {
  const dir = await fixture();
  const hash = () => sourceHash(dir, '0.0.0', 'module-a');
  const original = await hash();
  expect(await hash()).toBe(original);
  expect(await sourceHash(dir, '0.0.1', 'module-a')).not.toBe(original);
  expect(await sourceHash(dir, '0.0.0', 'module-b')).not.toBe(original);
  await writeFile(join(dir, 'main.go'), 'package main\r\n');
  expect(await hash()).not.toBe(original);
  await writeFile(join(dir, 'main.go'), 'package main\n');
  await rename(join(dir, 'main.go'), join(dir, 'agent.go'));
  expect(await hash()).not.toBe(original);
  await rename(join(dir, 'agent.go'), join(dir, 'main.go'));
  await writeFile(join(dir, 'extra'), 'x');
  expect(await hash()).not.toBe(original);
  await rm(join(dir, 'extra'));
  for (const name of ['.x', '_x']) {
    await mkdir(join(dir, name));
    await writeFile(join(dir, name, 'extra'), 'x');
  }
  expect(await hash()).toBe(original);
  await symlink(join(dir, 'main.go'), join(dir, 'link.go'));
  await expect(hash()).rejects.toThrow('symlink');
});
test('tree framing is deterministic and unambiguous', async () => {
  const dir = await fixture();
  const hash = await hashTree(dir);
  const other = await fixture();
  expect(await hashTree(other)).toBe(hash);
  await writeFile(join(other, 'main.go'), 'package main!\n');
  expect(await hashTree(other)).not.toBe(hash);
});
test('the starter module shares the locked dependencies and checksums', async () => {
  const original = await readFile('go/go.mod', 'utf8');
  const starter = await readFile('templates/frameworks/adk-go/files/go/go.mod', 'utf8');
  expect(starter.match(/require \([\s\S]*?\n\)/g)).toEqual(
    original.match(/require \([\s\S]*?\n\)/g),
  );
  expect(starter).toContain(
    'replace galaxie.invalid/galaxie => ../node_modules/@galaxie-ai/starter-go/dist/go-module',
  );
  expect(await readFile('templates/frameworks/adk-go/files/go/go.sum')).toEqual(
    await readFile('go/go.sum'),
  );
});
test('Go author source has one home and no JavaScript bridge import', async () => {
  for (const file of await readdir('packages/starter-go', { recursive: true })) {
    if (file.endsWith('.go'))
      expect(await readFile(join('packages/starter-go', file), 'utf8')).not.toMatch(/package main/);
  }
  for (const file of ['main.go', 'agent.go']) {
    const text = await readFile(join('templates/frameworks/adk-go/files/go', file), 'utf8');
    expect(
      text.startsWith(
        '// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n// SPDX-License-Identifier: Apache-2.0',
      ),
    ).toBe(true);
    expect(text).not.toContain('syscall/js');
  }
});
test('build settings follow the Go lock and discard ambient overrides', async () => {
  const lock = JSON.parse(await readFile('go/wasm.lock', 'utf8'));
  expect(() => checkBuildSettings(lock)).not.toThrow();
  for (const key of ['toolchain', 'goos', 'goarch', 'cgo', 'flags', 'ldflags']) {
    const changed = structuredClone(lock);
    if (key === 'toolchain') changed.toolchain = 'go1.27.4';
    else changed.build[key] = 'changed';
    expect(() => checkBuildSettings(changed)).toThrow('drift');
  }
  const env = buildEnvironment({
    PATH: '/bin',
    HOME: '/home/test',
    GOFLAGS: '-race',
    GOENV: '/tmp/goenv',
    GOEXPERIMENT: 'x',
    SECRET: 'x',
  });
  expect(env).toEqual({
    PATH: '/bin',
    HOME: '/home/test',
    GOTOOLCHAIN: 'local',
    GOENV: 'off',
    GOOS: 'js',
    GOARCH: 'wasm',
    CGO_ENABLED: '0',
    GOWORK: 'off',
    GOWASM: '',
    GOEXPERIMENT: '',
    GOFLAGS: '-mod=readonly -trimpath -buildvcs=false',
  });
  expect(buildSettings.toolchain).toBe('go1.27.3');
});
test('the temporary starter passes native go vet', async (context) => {
  const version = spawnSync('go', ['env', 'GOVERSION'], {
    env: buildEnvironment(),
    encoding: 'utf8',
  });
  if (version.stdout?.trim() !== buildSettings.toolchain) {
    if (process.env['CI']) throw new Error('Go 1.27.3 is required in CI.');
    console.info('Skipping starter native vet: Go 1.27.3 is not on PATH.');
    context.skip();
    return;
  }
  const dir = await fixture();
  await rm(join(dir, 'main.go'));
  await cp('templates/frameworks/adk-go/files/go', join(dir, 'go'), { recursive: true });
  const module = join(dir, 'node_modules/@galaxie-ai/starter-go/dist/go-module');
  await mkdir(module, { recursive: true });
  await cp('go/galaxie', join(module, 'galaxie'), {
    recursive: true,
    filter: (p) => !p.endsWith('_test.go'),
  });
  for (const file of ['go.mod', 'go.sum']) await cp(join('go', file), join(module, file));
  const nativeOptions = {
    cwd: resolve(dir, 'go'),
    env: {
      ...buildEnvironment(),
      GOOS: process.platform === 'darwin' ? 'darwin' : 'linux',
      GOARCH: process.arch === 'arm64' ? 'arm64' : 'amd64',
    },
    encoding: 'utf8' as const,
  };
  // Keep cold-cache download progress separate from vet diagnostics.
  const download = spawnSync('go', ['mod', 'download'], nativeOptions);
  expect(download.status, download.stderr).toBe(0);
  const result = spawnSync('go', ['vet', '.'], nativeOptions);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}, 120_000);

test('a symlink at the source tree root is refused', async () => {
  const parent = await fixture();
  const source = join(parent, 'source');
  await mkdir(source);
  await writeFile(join(source, 'main.go'), 'package main\n');
  const link = join(parent, 'linked-source');
  await symlink(source, link, 'dir');
  await expect(sourceHash(link, '0.0.0', 'module-a')).rejects.toThrow('symlink');
});
