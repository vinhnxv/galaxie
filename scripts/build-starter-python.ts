// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LockedWheel } from '../packages/adapter-pyodide/src/runtime-files.js';
import type { StarterManifest } from '../packages/starter-python/src/manifest.js';

// This inventory executes directly under Node's TypeScript stripping.
const { lockedWheels, runtimeFiles } = (await import(
  new URL('../packages/adapter-pyodide/src/runtime-files.ts', import.meta.url).href
)) as typeof import('../packages/adapter-pyodide/src/runtime-files.js');
const root = fileURLToPath(new URL('..', import.meta.url));

export async function buildStarterDist(
  packageDirectory: string = join(root, 'packages/starter-python'),
  options: { readonly wheelCache?: string } = {},
): Promise<StarterManifest> {
  const dist = join(packageDirectory, 'dist');
  await mkdir(dist, { recursive: true });
  if (!(await lstat(dist)).isDirectory()) throw new Error('The Python starter output is invalid.');
  await rm(join(dist, 'manifest.json'), { force: true });
  const [
    { collectNotices },
    { validArtifact, validFileName },
    { fileMetadata, verifyDist, invalidWheel },
  ] = await Promise.all([
    import(pathToFileURL(join(dist, 'notices.js')).href) as Promise<
      typeof import('../packages/starter-python/src/notices.js')
    >,
    import(pathToFileURL(join(dist, 'manifest.js')).href) as Promise<
      typeof import('../packages/starter-python/src/manifest.js')
    >,
    import(pathToFileURL(join(dist, 'build.js')).href) as Promise<
      typeof import('../packages/starter-python/src/build.js')
    >,
  ]);
  const wheelCache = options.wheelCache ?? join(root, '.cache/python-wheels');
  const required = lockedWheels.filter(
    (wheel) => !wheel.frameworks || wheel.frameworks.includes('langgraph'),
  );
  const contents: { name: string; version: string; file: string; bytes: Buffer }[] = [];
  const readWheel = async (wheel: LockedWheel): Promise<void> => {
    const message = invalidWheel(wheel.file);
    if (!validFileName(wheel.file) || !wheel.file.endsWith('.whl') || !validArtifact(wheel))
      throw new Error(message);
    let bytes: Buffer;
    try {
      if (!(await lstat(join(wheelCache, wheel.file))).isFile()) throw new Error(message);
      bytes = await readFile(join(wheelCache, wheel.file));
    } catch {
      throw new Error(message);
    }
    if (
      bytes.byteLength !== wheel.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== wheel.sha256
    )
      throw new Error(message);
    contents.push({ name: wheel.name, version: wheel.version, file: wheel.file, bytes });
  };
  for (const wheel of required) await readWheel(wheel);
  let local: { v: string; packages: LockedWheel[] };
  try {
    local = JSON.parse(
      await readFile(join(wheelCache, 'local-wheels.json'), 'utf8'),
    ) as typeof local;
    if (
      local.v !== 'galaxie.python-build/v1' ||
      !Array.isArray(local.packages) ||
      local.packages.length !== 2 ||
      local.packages.filter((wheel) => wheel?.name === 'galaxie').length !== 1 ||
      local.packages.filter((wheel) => wheel?.name === 'ormsgpack').length !== 1
    )
      throw new Error('invalid');
  } catch {
    throw new Error(
      'The Python starter local wheel inventory could not be verified: local-wheels.json.',
    );
  }
  for (const wheel of local.packages) await readWheel(wheel);
  if (new Set(contents.map((wheel) => wheel.file)).size !== contents.length)
    throw new Error('The Python starter wheel inventory contains duplicate files.');
  const policy = JSON.parse(
    await readFile(join(root, 'scripts/dependency-license-allowlist.json'), 'utf8'),
  ) as { permissive: string[] };
  const notices = collectNotices(contents, {
    permissive: policy.permissive,
    repositoryLicense: await readFile(join(packageDirectory, 'LICENSE'), 'utf8'),
  });
  const adapterPackage = join(root, 'packages/adapter-pyodide/package.json');
  const runtimeDirectory = dirname(createRequire(adapterPackage).resolve('pyodide/package.json'));
  const runtimePackage = JSON.parse(
    await readFile(join(runtimeDirectory, 'package.json'), 'utf8'),
  ) as { version: string };
  const adapter = JSON.parse(await readFile(adapterPackage, 'utf8')) as {
    dependencies: { pyodide: string };
  };
  if (runtimePackage.version !== adapter.dependencies.pyodide)
    throw new Error('The Python starter Pyodide version does not match the adapter pin.');
  const runtime = [];
  for (const file of runtimeFiles) {
    const actual = await fileMetadata(join(runtimeDirectory, file.file));
    if (actual.bytes !== file.bytes)
      throw new Error(`The Python starter runtime could not be verified: ${file.file}.`);
    runtime.push({ file: file.file, ...actual });
  }
  const pkg = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as {
    version: string;
  };
  await rm(join(dist, 'wheels'), { recursive: true, force: true });
  await mkdir(join(dist, 'wheels'));
  for (const wheel of contents) await writeFile(join(dist, 'wheels', wheel.file), wheel.bytes);
  await rm(join(dist, 'NOTICE.txt'), { force: true });
  await writeFile(
    join(dist, 'NOTICE.txt'),
    `${await readFile(join(packageDirectory, 'NOTICE'), 'utf8')}\n${notices.text}`,
  );
  const manifest: StarterManifest = {
    version: pkg.version,
    pyodideVersion: runtimePackage.version,
    wheels: notices.wheels,
    runtimeFiles: runtime,
    notices: await fileMetadata(join(dist, 'NOTICE.txt')),
  };
  await writeFile(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    return await verifyDist(packageDirectory, manifest);
  } catch (error) {
    await rm(join(dist, 'manifest.json'), { force: true });
    throw error;
  }
}

if (import.meta.main) {
  const manifest = await buildStarterDist();
  console.log(
    `Verified ${manifest.wheels.length} LangGraph Python starter wheels (${manifest.wheels.reduce((sum, wheel) => sum + wheel.bytes, 0)} bytes).`,
  );
}
