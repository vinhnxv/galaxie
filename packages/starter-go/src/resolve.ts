// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgent, buildSettings, runGo } from './build-env.js';
import { invalidArtifact, missingGo } from './errors.js';
import { type ArtifactMetadata, readManifest } from './manifest.js';
import { checkReplacements, hashTree, sourceHash } from './source-hash.js';
import { fileMetadata, verifyArtifact } from './verify.js';

export interface ResolveOptions {
  readonly projectDirectory: string;
  readonly packageDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}
export interface ResolvedAgent {
  readonly origin: 'cache' | 'prebuilt' | 'local';
  readonly file: string;
  readonly sourceSha256: string;
  readonly wasm: ArtifactMetadata;
  readonly glue: ArtifactMetadata & { readonly file: string };
  readonly notices: ArtifactMetadata & { readonly file: string };
}

async function cachedArtifact(
  directory: string,
  expected?: ArtifactMetadata,
): Promise<ArtifactMetadata | undefined> {
  try {
    const metadata = await fileMetadata(join(directory, 'agent.wasm'));
    if (expected)
      return metadata.sha256 === expected.sha256 && metadata.bytes === expected.bytes
        ? metadata
        : undefined;
    const sidecar = await readFile(join(directory, 'agent.wasm.sha256'), 'utf8');
    return metadata.sha256 === sidecar.trim() ? metadata : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve without probing Go until neither a verified cache nor the prebuilt matches. */
export async function resolveAgent(options: ResolveOptions): Promise<ResolvedAgent> {
  const project = resolve(options.projectDirectory);
  const packageDirectory = resolve(
    options.packageDirectory ?? fileURLToPath(new URL('..', import.meta.url)),
  );
  const dist = join(packageDirectory, 'dist');
  const manifest = await readManifest(dist);
  const pkg = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as {
    version: string;
  };
  const directory = join(project, 'go');
  async function checkedModuleHash(): Promise<string> {
    const digest = await hashTree(join(dist, 'go-module'));
    if (digest !== manifest.goModule.sha256) throw new Error(invalidArtifact);
    if (await checkReplacements(directory)) {
      const replacement = await hashTree(
        join(project, 'node_modules/@galaxie-ai/starter-go/dist/go-module'),
      ).catch(() => {
        throw new Error(invalidArtifact);
      });
      if (replacement !== digest) throw new Error(invalidArtifact);
    }
    return digest;
  }
  if (pkg.version !== manifest.version) throw new Error(invalidArtifact);
  const moduleSha256 = await checkedModuleHash();
  const sourceSha256 = await sourceHash(directory, pkg.version, moduleSha256);
  const cacheRoot = join(project, 'node_modules/.cache/galaxie-go');
  const cache = join(cacheRoot, sourceSha256);
  const glue = { ...manifest.glue, file: join(dist, 'wasm_exec.js') };
  const notices = { ...manifest.notices, file: join(dist, 'NOTICE.txt') };
  await verifyArtifact(glue.file, glue);
  await verifyArtifact(notices.file, notices);
  const cached = await cachedArtifact(
    cache,
    sourceSha256 === manifest.sourceSha256 ? manifest.wasm : undefined,
  );
  if (cached)
    return {
      origin: 'cache',
      file: join(cache, 'agent.wasm'),
      sourceSha256,
      wasm: cached,
      glue,
      notices,
    };
  if (sourceSha256 === manifest.sourceSha256) {
    const file = join(dist, 'agent.wasm');
    await verifyArtifact(file, manifest.wasm);
    return { origin: 'prebuilt', file, sourceSha256, wasm: manifest.wasm, glue, notices };
  }
  const environment = options.environment ?? process.env;
  const toolchain = await runGo(['env', 'GOVERSION'], directory, environment).catch(
    () => undefined,
  );
  if (toolchain?.trim() !== buildSettings.toolchain) throw new Error(missingGo);
  await mkdir(cacheRoot, { recursive: true });
  const temporary = await mkdtemp(join(cacheRoot, `.${sourceSha256}-`));
  try {
    const output = join(temporary, 'agent.wasm');
    await buildAgent(directory, output, environment);
    const compiledSource = await sourceHash(directory, pkg.version, await checkedModuleHash());
    if (compiledSource !== sourceSha256)
      throw new Error('The Go starter source changed during compilation; run the build again.');
    const wasm = await fileMetadata(output);
    await writeFile(join(temporary, 'agent.wasm.sha256'), `${wasm.sha256}\n`);
    // Each rename is atomic. Until both agree, readers ignore the incomplete entry.
    // Replacing files preserves concurrent readers of a previously verified artifact.
    await mkdir(cache, { recursive: true });
    await rename(output, join(cache, 'agent.wasm'));
    await rename(join(temporary, 'agent.wasm.sha256'), join(cache, 'agent.wasm.sha256'));
    return { origin: 'local', file: join(cache, 'agent.wasm'), sourceSha256, wasm, glue, notices };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
