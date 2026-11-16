// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StarterManifest } from '../packages/starter-go/src/manifest.js';

// These repository tools execute directly under Node's TypeScript stripping.
const { readGoWasmLock, allowedLicenses } = (await import(
  new URL('./go-wasm-lock.ts', import.meta.url).href
)) as typeof import('./go-wasm-lock.js');
const { fetchGoGlue } = (await import(
  new URL('./fetch-go-glue.ts', import.meta.url).href
)) as typeof import('./fetch-go-glue.js');
const { classifyLicense } = (await import(
  new URL('./check-go-lock.ts', import.meta.url).href
)) as typeof import('./check-go-lock.js');
const root = fileURLToPath(new URL('..', import.meta.url));

export async function buildStarterDist(
  packageDirectory: string = join(root, 'packages/starter-go'),
  options: { readonly environment?: NodeJS.ProcessEnv } = {},
): Promise<StarterManifest> {
  const [
    { buildAgent, buildSettings, checkBuildSettings, runGo },
    { copyModuleSource },
    { collectNotices },
    { hashTree, sourceHash },
    { fileMetadata, verifyDist },
  ] = await Promise.all([
    import(new URL('../packages/starter-go/dist/build-env.js', import.meta.url).href) as Promise<
      typeof import('../packages/starter-go/src/build-env.js')
    >,
    import(
      new URL('../packages/starter-go/dist/module-source.js', import.meta.url).href
    ) as Promise<typeof import('../packages/starter-go/src/module-source.js')>,
    import(new URL('../packages/starter-go/dist/notices.js', import.meta.url).href) as Promise<
      typeof import('../packages/starter-go/src/notices.js')
    >,
    import(new URL('../packages/starter-go/dist/source-hash.js', import.meta.url).href) as Promise<
      typeof import('../packages/starter-go/src/source-hash.js')
    >,
    import(new URL('../packages/starter-go/dist/verify.js', import.meta.url).href) as Promise<
      typeof import('../packages/starter-go/src/verify.js')
    >,
  ]);
  const environment = options.environment ?? process.env;
  const repositoryGo = join(root, 'go');
  const template = join(root, 'templates/frameworks/adk-go/files/go');
  const lock = await readGoWasmLock();
  checkBuildSettings(lock);
  const toolchain = (await runGo(['env', 'GOVERSION'], repositoryGo, environment)).trim();
  if (toolchain !== lock.toolchain)
    throw new Error(`The Go toolchain is ${toolchain}; go/wasm.lock pins ${lock.toolchain}.`);
  const goroot = (await runGo(['env', 'GOROOT'], repositoryGo, environment)).trim();
  const dist = join(packageDirectory, 'dist');
  await mkdir(dist, { recursive: true });
  // A failed pack never leaves a previous manifest claiming the new files are complete.
  await rm(join(dist, 'manifest.json'), { force: true });
  await fetchGoGlue(goroot, dist);
  await rm(join(dist, 'go-module'), { recursive: true, force: true });
  await copyModuleSource(repositoryGo, join(dist, 'go-module'));
  const temporary = await mkdtemp(join(tmpdir(), 'galaxie-starter-build-'));
  try {
    await cp(template, join(temporary, 'go'), { recursive: true });
    await mkdir(join(temporary, 'node_modules/@galaxie-ai'), { recursive: true });
    await symlink(
      resolve(packageDirectory),
      join(temporary, 'node_modules/@galaxie-ai/starter-go'),
      'dir',
    );
    const directory = join(temporary, 'go');
    const output = await runGo(
      ['list', '-deps', '-f', '{{with .Module}}{{.Path}} {{.Version}}{{end}}', '.'],
      directory,
      environment,
    );
    const found = new Map<string, string>();
    for (const line of output.split('\n')) {
      const [path, version] = line.trim().split(' ');
      if (path && version && path !== 'galaxie.invalid/galaxie') found.set(path, version);
    }
    const notices = await collectNotices({
      modules: [...found].map(([path, version]) => ({ path, version })),
      lock: lock.modules,
      allowedLicenses,
      classifyLicense,
      goroot,
      moduleCache: (await runGo(['env', 'GOMODCACHE'], directory, environment)).trim(),
    });
    await buildAgent(directory, join(dist, 'agent.wasm'), environment);
    const pkg = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as {
      version: string;
    };
    const moduleSha256 = await hashTree(join(dist, 'go-module'));
    const manifest: StarterManifest = {
      version: pkg.version,
      sourceSha256: await sourceHash(directory, pkg.version, moduleSha256),
      wasm: await fileMetadata(join(dist, 'agent.wasm')),
      glue: await fileMetadata(join(dist, 'wasm_exec.js')),
      goModule: { sha256: moduleSha256 },
      toolchain,
      flags: [...buildSettings.flags, `-ldflags=${buildSettings.ldflags}`],
      modules: notices.modules,
    };
    await writeFile(join(dist, 'NOTICE.txt'), notices.text);
    await writeFile(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return await verifyDist(packageDirectory, template, repositoryGo);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await buildStarterDist(process.argv[2]);
  console.log(`Built Go starter: ${manifest.wasm.bytes} bytes sha256:${manifest.wasm.sha256}`);
}
