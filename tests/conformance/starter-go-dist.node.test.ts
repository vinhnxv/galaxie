// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { buildAgent, runGo } from '../../packages/starter-go/src/build-env.js';
import { collectNotices } from '../../packages/starter-go/src/notices.js';
import { fileMetadata, verifyDist } from '../../packages/starter-go/src/verify.js';
import { buildStarterDist } from '../../scripts/build-starter-go.js';
import { classifyLicense } from '../../scripts/check-go-lock.js';
import { allowedLicenses, readGoWasmLock } from '../../scripts/go-wasm-lock.js';
import { buildStarterDistOnce, cleanStarterDist, hasStarterGo } from './support/starter-go.node.js';

const available = hasStarterGo();
const temporary: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'galaxie-starter-proof-'));
  temporary.push(dir);
  return dir;
}
afterAll(async () => {
  await cleanStarterDist();
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

test.skipIf(!available)(
  'four clean, dirty-git and symlink builds have one wasm digest',
  async () => {
    const dist = await buildStarterDistOnce();
    const digests: string[] = [dist.manifest.wasm.sha256];
    expect(dist.manifest.wasm.bytes).toBeLessThan(48 * 1024 * 1024);
    for (const layout of ['clean', 'git', 'symlink']) {
      const dir = await temporaryDirectory();
      await cp('templates/frameworks/adk-go/files/go', join(dir, 'go'), { recursive: true });
      const parent = join(dir, 'node_modules/@galaxie-ai');
      await mkdir(parent, { recursive: true });
      const pkg = join(parent, 'starter-go');
      if (layout === 'symlink') await symlink(dist.directory, pkg, 'dir');
      else await cp(dist.directory, pkg, { recursive: true });
      if (layout === 'git') {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        await writeFile(join(dir, 'uncommitted'), 'dirty');
      }
      const output = join(dir, 'agent.wasm');
      await buildAgent(join(dir, 'go'), output);
      digests.push((await fileMetadata(output)).sha256);
    }
    expect(new Set(digests).size).toBe(1);
  },
  300_000,
);

test.skipIf(!available)(
  'release verification detects source, package-version and module drift',
  async () => {
    const dist = await buildStarterDistOnce();
    await verifyDist(dist.directory, resolve('templates/frameworks/adk-go/files/go'));
    const dir = await temporaryDirectory();
    const pkg = join(dir, 'package');
    await cp(dist.directory, pkg, { recursive: true });
    const source = join(dir, 'go');
    await cp('templates/frameworks/adk-go/files/go', source, { recursive: true });
    await writeFile(
      join(source, 'main.go'),
      (await readFile(join(source, 'main.go'), 'utf8')) + '\n',
    );
    await expect(verifyDist(pkg, source)).rejects.toThrow('verified');
    await cp('templates/frameworks/adk-go/files/go/main.go', join(source, 'main.go'));
    const json = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
    json.version = '0.0.1';
    await writeFile(join(pkg, 'package.json'), JSON.stringify(json));
    await expect(verifyDist(pkg, source)).rejects.toThrow('verified');
    json.version = '0.0.0';
    await writeFile(join(pkg, 'package.json'), JSON.stringify(json));
    const repoGo = join(dir, 'repository-go');
    await cp('go/go.mod', join(dir, 'go.mod'));
    await mkdir(repoGo);
    for (const name of ['go.mod', 'go.sum']) await cp(join('go', name), join(repoGo, name));
    await cp('go/galaxie', join(repoGo, 'galaxie'), { recursive: true });
    await writeFile(join(repoGo, 'galaxie', 'change.go'), 'package galaxie\n');
    await expect(verifyDist(pkg, source, repoGo)).rejects.toThrow('verified');
  },
  120_000,
);

test.skipIf(!available)(
  'the builder rejects the wrong toolchain and altered toolchain glue',
  async () => {
    const dir = await temporaryDirectory();
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'go'), '#!/bin/sh\necho go1.27.4\n', { mode: 0o755 });
    await expect(
      buildStarterDist(dir, { environment: { ...process.env, PATH: bin } }),
    ).rejects.toThrow('The Go toolchain is go1.27.4; go/wasm.lock pins go1.27.3.');
    const goroot = join(dir, 'goroot');
    await mkdir(join(goroot, 'lib/wasm'), { recursive: true });
    const actual = await runGo(['env', 'GOROOT'], resolve('go'));
    const glue = await readFile(join(actual.trim(), 'lib/wasm/wasm_exec.js'));
    glue[0] = (glue[0] ?? 0) ^ 1;
    await writeFile(join(goroot, 'lib/wasm/wasm_exec.js'), glue);
    await writeFile(
      join(bin, 'go'),
      `#!/bin/sh\ncase "$2" in GOVERSION) echo go1.27.3;; GOROOT) echo '${goroot}';; esac\n`,
      { mode: 0o755 },
    );
    await expect(
      buildStarterDist(dir, { environment: { ...process.env, PATH: bin } }),
    ).rejects.toThrow('The Go glue file could not be verified.');
  },
  120_000,
);

test.skipIf(!available)(
  'notices cover Go and every compiled locked module',
  async () => {
    const dist = await buildStarterDistOnce();
    const notice = await readFile(join(dist.directory, 'dist/NOTICE.txt'), 'utf8');
    expect(notice).toContain('The Go Authors');
    expect(notice).toContain('Redistribution and use in source and binary forms');
    expect(dist.manifest.modules.length).toBeGreaterThan(0);
    for (const module of dist.manifest.modules) {
      expect(notice).toContain(`${module.path}@${module.version}`);
      expect(allowedLicenses).toContain(module.license);
    }
    const lock = await readGoWasmLock();
    const options = {
      modules: dist.manifest.modules,
      lock: lock.modules,
      allowedLicenses,
      classifyLicense,
      goroot: (await runGo(['env', 'GOROOT'], resolve('go'))).trim(),
      moduleCache: (await runGo(['env', 'GOMODCACHE'], resolve('go'))).trim(),
    };
    await expect(collectNotices({ ...options, lock: [] })).rejects.toThrow('lock');
    await expect(collectNotices({ ...options, allowedLicenses: [] })).rejects.toThrow('license');
    await expect(
      collectNotices({ ...options, moduleCache: await temporaryDirectory() }),
    ).rejects.toThrow('license');
  },
  120_000,
);

test.skipIf(!available)(
  'the built module contains no tests and a broken replace target cannot build',
  async () => {
    const dist = await buildStarterDistOnce();
    const dir = await temporaryDirectory();
    await cp('templates/frameworks/adk-go/files/go', join(dir, 'go'), { recursive: true });
    await expect(buildAgent(join(dir, 'go'), join(dir, 'bad.wasm'))).rejects.toThrow(
      'replacement directory',
    );
    expect(dist.manifest.toolchain).toBe('go1.27.3');
  },
  120_000,
);
