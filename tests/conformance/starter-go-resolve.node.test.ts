// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildAgent, buildSettings } from '../../packages/starter-go/src/build-env.js';
import { invalidArtifact, missingGo } from '../../packages/starter-go/src/errors.js';
import type { StarterManifest } from '../../packages/starter-go/src/manifest.js';
import { resolveAgent } from '../../packages/starter-go/src/resolve.js';
import { hashTree, sourceHash } from '../../packages/starter-go/src/source-hash.js';
import { fileMetadata, verifyDist } from '../../packages/starter-go/src/verify.js';
import { buildStarterDistOnce, cleanStarterDist, hasStarterGo } from './support/starter-go.node.js';

const temporary: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'galaxie-resolve-'));
  temporary.push(dir);
  return dir;
}
afterAll(async () => {
  await cleanStarterDist();
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});
beforeAll(() => {
  execFileSync('pnpm', ['exec', 'tsc', '-p', 'packages/starter-go/tsconfig.build.json'], {
    encoding: 'utf8',
  });
});
interface Fixture {
  readonly projectDirectory: string;
  readonly packageDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly manifest: StarterManifest;
  readonly bin: string;
  readonly root: string;
}
async function release(pkg: string, go: string, version = '0.0.0'): Promise<StarterManifest> {
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ version }));
  const dist = join(pkg, 'dist');
  const goModule = await hashTree(join(dist, 'go-module'));
  const manifest: StarterManifest = {
    version,
    sourceSha256: await sourceHash(go, version, goModule),
    wasm: await fileMetadata(join(dist, 'agent.wasm')),
    glue: await fileMetadata(join(dist, 'wasm_exec.js')),
    notices: await fileMetadata(join(dist, 'NOTICE.txt')),
    goModule: { sha256: goModule },
    toolchain: 'go1.27.3',
    flags: [...buildSettings.flags, `-ldflags=${buildSettings.ldflags}`],
    modules: [],
  };
  await writeFile(join(dist, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}
async function fixture(): Promise<Fixture> {
  const root = await directory();
  const projectDirectory = join(root, 'project');
  const packageDirectory = join(root, 'package');
  const bin = join(root, 'bin');
  await mkdir(join(projectDirectory, 'go'), { recursive: true });
  await mkdir(join(packageDirectory, 'dist/go-module'), { recursive: true });
  await mkdir(bin);
  await writeFile(join(projectDirectory, 'go/main.go'), 'package main\nfunc main() {}\n');
  await writeFile(
    join(packageDirectory, 'dist/go-module/go.mod'),
    'module galaxie.invalid/galaxie\n',
  );
  await writeFile(
    join(packageDirectory, 'dist/agent.wasm'),
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  );
  await writeFile(join(packageDirectory, 'dist/wasm_exec.js'), 'verified glue');
  await writeFile(join(packageDirectory, 'dist/NOTICE.txt'), 'original notices');
  const manifest = await release(packageDirectory, join(projectDirectory, 'go'));
  return {
    root,
    projectDirectory,
    packageDirectory,
    bin,
    manifest,
    environment: {
      PATH: bin,
      HOME: root,
      GOPROXY: 'off',
      GOSUMDB: 'off',
      GOFLAGS: '-race',
      GOENV: 'bad',
      GOEXPERIMENT: 'bad',
    },
  };
}
function cacheDirectory(f: Fixture, hash = f.manifest.sourceSha256): string {
  return join(f.projectDirectory, 'node_modules/.cache/galaxie-go', hash);
}
async function seedCache(f: Fixture, bytes: string | Buffer, corrupt = false): Promise<void> {
  const dir = cacheDirectory(f);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'agent.wasm'), bytes);
  await writeFile(
    join(dir, 'agent.wasm.sha256'),
    corrupt ? 'bad' : (await fileMetadata(join(dir, 'agent.wasm'))).sha256,
  );
}
async function edited(f: Fixture): Promise<void> {
  await writeFile(
    join(f.projectDirectory, 'go/main.go'),
    'package main\nfunc main() { println("edited") }\n',
  );
}
async function fakeGo(f: Fixture, version: string, buildBody: string): Promise<string> {
  const log = join(f.root, 'go-calls.jsonl');
  await writeFile(
    join(f.bin, 'go'),
    `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,cwd:process.cwd(),env:process.env})+'\\n');if(args[0]==='env') {process.stdout.write(${JSON.stringify(version)}+'\\n');} else {${buildBody}}\n`,
    { mode: 0o755 },
  );
  return log;
}

test('verified cache wins over a matching manifest, including a damaged prebuilt', async () => {
  const f = await fixture();
  const original = await readFile(join(f.packageDirectory, 'dist/agent.wasm'));
  await seedCache(f, original);
  await writeFile(join(f.packageDirectory, 'dist/agent.wasm'), 'damaged prebuilt');
  const result = await resolveAgent(f);
  expect(result.origin).toBe('cache');
  expect(await readFile(result.file)).toEqual(original);
});

test('matching source never trusts a forged cache and matching sidecar over the manifest', async () => {
  const f = await fixture();
  await seedCache(f, Buffer.alloc(f.manifest.wasm.bytes, 120));
  const result = await resolveAgent(f);
  expect(result.origin).toBe('prebuilt');
  expect(result.wasm).toEqual(f.manifest.wasm);
  await writeFile(join(f.packageDirectory, 'dist/agent.wasm'), 'damaged prebuilt');
  await expect(resolveAgent(f)).rejects.toThrow(invalidArtifact);
});

test('matching-source cache checks the manifest length independently of its digest', async () => {
  const f = await fixture();
  await seedCache(f, await readFile(join(f.packageDirectory, 'dist/agent.wasm')));
  await writeFile(
    join(f.packageDirectory, 'dist/manifest.json'),
    JSON.stringify({
      ...f.manifest,
      wasm: { ...f.manifest.wasm, bytes: f.manifest.wasm.bytes + 1 },
    }),
  );
  await expect(resolveAgent(f)).rejects.toThrow(invalidArtifact);
});
test('matching source resolves prebuilt in a child with a PATH that records and rejects any Go call', async () => {
  const f = await fixture();
  const log = join(f.root, 'forbidden-go');
  await writeFile(
    join(f.bin, 'go'),
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},'called');process.exit(1);\n`,
    { mode: 0o755 },
  );
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const {resolveAgent}=await import(process.argv[1]);process.stdout.write(JSON.stringify(await resolveAgent(JSON.parse(process.argv[2]))));`,
      pathToFileURL(resolve('packages/starter-go/dist/build.js')).href,
      JSON.stringify({
        projectDirectory: f.projectDirectory,
        packageDirectory: f.packageDirectory,
      }),
    ],
    { env: { ...process.env, PATH: f.bin }, encoding: 'utf8' },
  );
  expect(child.stderr).toBe('');
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout).origin).toBe('prebuilt');
  await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(
    readdir(join(f.projectDirectory, 'node_modules/.cache/galaxie-go')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
test('the fixed missing-toolchain message is exact in errors and package documentation', async () => {
  const expected =
    'The agent source in go/ was edited and Go 1.27.3 was not found on PATH. Install Go 1.27.3, or restore the original go/ source to use the prebuilt agent.';
  expect(missingGo).toBe(expected);
  expect(await readFile('packages/starter-go/README.md', 'utf8')).toContain(expected);
  const f = await fixture();
  await edited(f);
  await expect(resolveAgent(f)).rejects.toMatchObject({ message: expected });
  await fakeGo(f, 'go1.27.4', "throw new Error('must not build')");
  await expect(resolveAgent(f)).rejects.toMatchObject({ message: expected });
});
test('the pinned local compiler runs with isolated flags and atomically populates the cache', async () => {
  const f = await fixture();
  await edited(f);
  const log = await fakeGo(
    f,
    'go1.27.3',
    "fs.writeFileSync(args[args.indexOf('-o')+1],'compiled wasm');",
  );
  const result = await resolveAgent(f);
  expect(result.origin).toBe('local');
  expect(result.sourceSha256).not.toBe(f.manifest.sourceSha256);
  expect(await readFile(result.file, 'utf8')).toBe('compiled wasm');
  const calls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(calls).toHaveLength(2);
  expect(calls[0].args).toEqual(['env', 'GOVERSION']);
  expect(calls[1].args).toEqual([
    'build',
    '-ldflags=-s -w -buildid=',
    '-o',
    expect.any(String),
    '.',
  ]);
  expect(calls[1].cwd).toBe(await realpath(join(f.projectDirectory, 'go')));
  expect(calls[1].env).toMatchObject({
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
  expect(await readFile(join(dirname(result.file), 'agent.wasm.sha256'), 'utf8')).toBe(
    `${result.wasm.sha256}\n`,
  );
  const cached = await resolveAgent(f);
  expect(cached.origin).toBe('cache');
  expect(cached.wasm).toEqual(result.wasm);
  expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(2);
});
test('concurrent local builds publish complete cache entries', async () => {
  const f = await fixture();
  await edited(f);
  await fakeGo(
    f,
    'go1.27.3',
    "setTimeout(()=>fs.writeFileSync(args[args.indexOf('-o')+1],'concurrent wasm'),50);",
  );
  const results = await Promise.all([resolveAgent(f), resolveAgent(f)]);
  expect(results.some((result) => result.origin === 'local')).toBe(true);
  expect(results.every((result) => result.origin === 'local' || result.origin === 'cache')).toBe(
    true,
  );
  expect(results[0]?.wasm).toEqual(results[1]?.wasm);
  const cached = await resolveAgent(f);
  expect(cached.origin).toBe('cache');
  expect(await readFile(cached.file, 'utf8')).toBe('concurrent wasm');
  expect(await readdir(join(f.projectDirectory, 'node_modules/.cache/galaxie-go'))).toEqual([
    cached.sourceSha256,
  ]);
});
test('corrupt cache is ignored, while matching-source artifact corruption is an integrity error', async () => {
  const f = await fixture();
  await seedCache(f, 'broken cache', true);
  expect((await resolveAgent(f)).origin).toBe('prebuilt');
  for (const artifact of ['agent.wasm', 'wasm_exec.js', 'NOTICE.txt']) {
    const path = join(f.packageDirectory, 'dist', artifact);
    const previous = await readFile(path);
    await writeFile(path, 'tampered');
    await expect(resolveAgent(f)).rejects.toMatchObject({ message: invalidArtifact });
    await writeFile(path, previous);
  }
});

test.each(['missing', 'digest', 'bytes'] as const)(
  'NOTICE metadata is required and checked at resolution and release: %s',
  async (mutation) => {
    const f = await fixture();
    const manifest = JSON.parse(
      await readFile(join(f.packageDirectory, 'dist/manifest.json'), 'utf8'),
    );
    if (mutation === 'missing') delete manifest.notices;
    else if (mutation === 'bytes') manifest.notices.bytes += 1;
    else manifest.notices.sha256 = '0'.repeat(64);
    await writeFile(join(f.packageDirectory, 'dist/manifest.json'), JSON.stringify(manifest));
    await expect(resolveAgent(f)).rejects.toThrow(invalidArtifact);
    await expect(verifyDist(f.packageDirectory, join(f.projectDirectory, 'go'))).rejects.toThrow(
      invalidArtifact,
    );
  },
);

test.each(
  ['agent.wasm', 'NOTICE.txt', 'wasm_exec.js'].flatMap((artifact) =>
    ['after-read', 'digest', 'bytes'].map((mutation) => ({ artifact, mutation })),
  ),
)(
  'the Go overlay binds verified buffers to output: $artifact $mutation',
  async ({ artifact, mutation }) => {
    const f = await fixture();
    const dist = join(f.packageDirectory, 'dist');
    const file = join(dist, artifact);
    const original = await readFile(file);
    const installed = join(f.projectDirectory, 'node_modules/@galaxie-ai/starter-go');
    await mkdir(installed, { recursive: true });
    await cp('templates/frameworks/adk-go/files/vite.framework.ts', join(f.root, 'framework.ts'));
    await writeFile(
      join(installed, 'package.json'),
      JSON.stringify({ type: 'module', exports: { './build': './build.js' } }),
    );
    const entry = pathToFileURL(resolve('packages/starter-go/dist/build.js')).href;
    await writeFile(
      join(installed, 'build.js'),
      `import * as actual from ${JSON.stringify(entry)};
export const verifyArtifact = actual.verifyArtifact;
export async function resolveAgent() {
  const result = await actual.resolveAgent(${JSON.stringify(f)});
  ${mutation === 'digest' ? `await (await import('node:fs/promises')).writeFile(${JSON.stringify(file)}, Buffer.alloc(${original.byteLength}, 120));` : ''}
  ${mutation === 'bytes' ? `result.${artifact === 'agent.wasm' ? 'wasm' : artifact === 'NOTICE.txt' ? 'notices' : 'glue'}.bytes += 1;` : ''}
  globalThis.armed = true;
  return result;
}`,
    );
    const script = join(f.root, 'emit.mjs');
    await writeFile(
      script,
      `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFile;
let changed = false;
fs.readFile = async (...args) => {
  const bytes = await read(...args);
  if (globalThis.armed && !changed && args[0] === ${JSON.stringify(file)}) {
    changed = true;
    await fs.writeFile(args[0], 'changed after read');
  }
  return bytes;
};
syncBuiltinESMExports();
const { goFramework } = await import('./framework.ts');
const config = goFramework(${JSON.stringify(f.projectDirectory)});
const plugin = config.plugins.find((p) => p.name === 'galaxie-go-assets');
plugin.configResolved({ command: 'build' });
const emitted = [];
await plugin.buildStart.call({ emitFile(asset) { emitted.push([asset.fileName, Buffer.from(asset.source).toString('base64')]); } });
${artifact === 'wasm_exec.js' ? `const glue = config.plugins.find((p) => p.name === 'galaxie-go-glue'); emitted.push(['wasm_exec.js', Buffer.from(await glue.load('\\0galaxie-go-glue')).toString('base64')]);` : ''}
process.stdout.write(JSON.stringify({ changed, emitted }));`,
    );
    const child = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    if (mutation !== 'after-read') {
      expect(child.status).not.toBe(0);
      expect(child.stderr).toContain('The Go starter file could not be verified:');
      return;
    }
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.changed).toBe(true);
    expect(result.emitted).toContainEqual([
      artifact === 'wasm_exec.js' ? artifact : `go/${artifact}`,
      original.toString('base64'),
    ]);
    expect(await readFile(file, 'utf8')).toBe('changed after read');
  },
);
test('a tampered bundled Go module is an integrity error, not a source mismatch', async () => {
  const f = await fixture();
  await writeFile(join(f.packageDirectory, 'dist/go-module/go.mod'), 'module tampered\n');
  await expect(resolveAgent(f)).rejects.toMatchObject({ message: invalidArtifact });
});

test.each(['before', 'during'])(
  'the actual bundled replacement must match the package manifest %s compilation',
  async (timing) => {
    const f = await fixture();
    await writeFile(
      join(f.projectDirectory, 'go/go.mod'),
      'module example.invalid/starter\nreplace galaxie.invalid/galaxie => ../node_modules/@galaxie-ai/starter-go/dist/go-module\n',
    );
    const manifest = await release(f.packageDirectory, join(f.projectDirectory, 'go'));
    const replacement = join(
      f.projectDirectory,
      'node_modules/@galaxie-ai/starter-go/dist/go-module',
    );
    await mkdir(dirname(replacement), { recursive: true });
    await cp(join(f.packageDirectory, 'dist/go-module'), replacement, { recursive: true });
    expect((await resolveAgent(f)).origin).toBe('prebuilt');
    if (timing === 'before') {
      await seedCache(
        { ...f, manifest },
        await readFile(join(f.packageDirectory, 'dist/agent.wasm')),
      );
      await writeFile(join(replacement, 'go.mod'), 'module unchecked\n');
    } else {
      await edited(f);
      await fakeGo(
        f,
        'go1.27.3',
        `fs.writeFileSync(args[args.indexOf('-o')+1],'compiled wasm');fs.appendFileSync(${JSON.stringify(join(replacement, 'go.mod'))},'// concurrent replacement edit\\n');`,
      );
    }
    await expect(resolveAgent(f)).rejects.toThrow(invalidArtifact);
  },
);
test('a corrupt edited cache is rebuilt locally and failed or killed compilers leave no cache entry', async () => {
  const f = await fixture();
  await edited(f);
  const hash = await sourceHash(
    join(f.projectDirectory, 'go'),
    '0.0.0',
    f.manifest.goModule.sha256,
  );
  const dir = cacheDirectory(f, hash);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'agent.wasm'), 'corrupt');
  await writeFile(join(dir, 'agent.wasm.sha256'), 'bad');
  await fakeGo(f, 'go1.27.3', "fs.writeFileSync(args[args.indexOf('-o')+1],'rebuilt');");
  expect((await resolveAgent(f)).origin).toBe('local');
  await rm(dir, { recursive: true });
  const diagnostics = 'main.go:9: compiler diagnostic\n';
  await fakeGo(
    f,
    'go1.27.3',
    `process.stderr.write(${JSON.stringify(diagnostics)});process.exit(2);`,
  );
  await expect(resolveAgent(f)).rejects.toMatchObject({ message: diagnostics });
  await expect(readFile(join(dir, 'agent.wasm'))).rejects.toMatchObject({ code: 'ENOENT' });
  await fakeGo(
    f,
    'go1.27.3',
    "fs.writeFileSync(args[args.indexOf('-o')+1],'partial');process.kill(process.pid,'SIGKILL');",
  );
  await expect(resolveAgent(f)).rejects.toThrow();
  expect(await readdir(join(f.projectDirectory, 'node_modules/.cache/galaxie-go'))).toEqual([]);
});
test('a version-only release keeps the prebuilt path and a template-changing release requires Go for old projects', async () => {
  const f = await fixture();
  const old = f.manifest.sourceSha256;
  const bumped = await release(f.packageDirectory, join(f.projectDirectory, 'go'), '0.0.1');
  expect(bumped.sourceSha256).not.toBe(old);
  expect((await resolveAgent(f)).origin).toBe('prebuilt');
  const changed = join(f.root, 'new-template');
  await cp(join(f.projectDirectory, 'go'), changed, { recursive: true });
  await writeFile(
    join(changed, 'main.go'),
    'package main\nfunc main() {println("new template")}\n',
  );
  await release(f.packageDirectory, changed, '0.0.2');
  await expect(resolveAgent(f)).rejects.toMatchObject({ message: missingGo });
});
test.skipIf(!hasStarterGo())(
  'an edited real starter compiles once and its cached digest equals a second clean build',
  async () => {
    const dist = await buildStarterDistOnce();
    const root = await directory();
    const projectDirectory = join(root, 'project');
    await cp('templates/frameworks/adk-go/files/go', join(projectDirectory, 'go'), {
      recursive: true,
    });
    const pkg = join(projectDirectory, 'node_modules/@galaxie-ai/starter-go');
    await mkdir(dirname(pkg), { recursive: true });
    await cp(dist.directory, pkg, { recursive: true });
    const path = join(projectDirectory, 'go/agent.go');
    await writeFile(path, `${await readFile(path, 'utf8')}\n// Local edit for the cache proof.\n`);
    const local = await resolveAgent({ projectDirectory, packageDirectory: pkg });
    expect(local.origin).toBe('local');
    const second = join(root, 'second');
    await cp(projectDirectory, second, { recursive: true });
    await rm(join(second, 'node_modules/.cache'), { recursive: true, force: true });
    const output = join(root, 'second.wasm');
    await buildAgent(join(second, 'go'), output);
    expect(await fileMetadata(output)).toEqual(local.wasm);
    expect(
      (
        await resolveAgent({
          projectDirectory,
          packageDirectory: pkg,
          environment: { PATH: join(root, 'no-go') },
        })
      ).origin,
    ).toBe('cache');
  },
  180_000,
);

test('a source edit during compilation cannot populate a cache under the previous hash', async () => {
  const f = await fixture();
  await edited(f);
  const hash = await sourceHash(
    join(f.projectDirectory, 'go'),
    '0.0.0',
    f.manifest.goModule.sha256,
  );
  await fakeGo(
    f,
    'go1.27.3',
    `fs.writeFileSync(args[args.indexOf('-o')+1],'compiled after concurrent edit');fs.appendFileSync(${JSON.stringify(join(f.projectDirectory, 'go/main.go'))},'// concurrent edit\\n');`,
  );
  await expect(resolveAgent(f)).rejects.toThrow('source changed during compilation');
  await expect(readFile(join(cacheDirectory(f, hash), 'agent.wasm'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
