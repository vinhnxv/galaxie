// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invalidArtifact } from './errors.js';
import { type ArtifactMetadata, readManifest, type StarterManifest } from './manifest.js';
import { copyModuleSource } from './module-source.js';
import { hashTree, sourceHash } from './source-hash.js';

export async function fileMetadata(file: string): Promise<ArtifactMetadata> {
  const bytes = await readFile(file);
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export async function verifyArtifact(file: string, expected: ArtifactMetadata): Promise<void> {
  const actual = await fileMetadata(file).catch(() => {
    throw new Error(invalidArtifact);
  });
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
    throw new Error(invalidArtifact);
}
/** Release-time verification ties artifacts to both author and repository module source. */
export async function verifyDist(
  packageDirectory: string,
  templateDirectory: string,
  repositoryGoDirectory?: string,
): Promise<StarterManifest> {
  const dist = join(packageDirectory, 'dist');
  const manifest = await readManifest(dist);
  const pkg = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as {
    version: string;
  };
  const moduleSha256 = await hashTree(join(dist, 'go-module'));
  if (
    pkg.version !== manifest.version ||
    moduleSha256 !== manifest.goModule.sha256 ||
    (await sourceHash(templateDirectory, pkg.version, moduleSha256)) !== manifest.sourceSha256
  )
    throw new Error(invalidArtifact);
  if (repositoryGoDirectory) {
    const temporary = await mkdtemp(join(tmpdir(), 'galaxie-module-verify-'));
    try {
      await copyModuleSource(repositoryGoDirectory, temporary);
      if ((await hashTree(temporary)) !== moduleSha256) throw new Error(invalidArtifact);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  await verifyArtifact(join(dist, 'agent.wasm'), manifest.wasm);
  await verifyArtifact(join(dist, 'wasm_exec.js'), manifest.glue);
  return manifest;
}
