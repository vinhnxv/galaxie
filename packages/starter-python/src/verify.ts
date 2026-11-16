// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { invalidArtifact, invalidWheel } from './errors.js';
import { type ArtifactMetadata, readManifest, type StarterManifest } from './manifest.js';

export async function fileMetadata(file: string): Promise<ArtifactMetadata> {
  if (!(await lstat(file)).isFile()) throw new Error(invalidArtifact);
  const bytes = await readFile(file);
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function verifyArtifact(file: string, expected: ArtifactMetadata): Promise<void> {
  const message = file.endsWith('.whl') ? invalidWheel(basename(file)) : invalidArtifact;
  const actual = await fileMetadata(file).catch(() => {
    throw new Error(message);
  });
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
    throw new Error(message);
}

/** Compare release output to the build's authoritative manifest and artifact bytes. */
export async function verifyDist(
  packageDirectory: string,
  expected: StarterManifest,
): Promise<StarterManifest> {
  const dist = join(packageDirectory, 'dist');
  const manifest = await readManifest(dist);
  const pkg = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as {
    version: string;
  };
  if (pkg.version !== manifest.version || JSON.stringify(manifest) !== JSON.stringify(expected))
    throw new Error(invalidArtifact);
  if (!(await lstat(join(dist, 'wheels'))).isDirectory()) throw new Error(invalidArtifact);
  for (const wheel of manifest.wheels)
    await verifyArtifact(join(dist, 'wheels', wheel.file), wheel);
  const actual = (await readdir(join(dist, 'wheels'))).sort();
  if (JSON.stringify(actual) !== JSON.stringify(manifest.wheels.map((wheel) => wheel.file).sort()))
    throw new Error(invalidArtifact);
  await verifyArtifact(join(dist, 'NOTICE.txt'), manifest.notices);
  return manifest;
}
