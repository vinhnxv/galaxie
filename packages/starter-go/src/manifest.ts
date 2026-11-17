// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invalidArtifact } from './errors.js';

export interface ArtifactMetadata {
  readonly sha256: string;
  readonly bytes: number;
}
export interface StarterModule {
  readonly path: string;
  readonly version: string;
  readonly license: string;
}
export interface StarterManifest {
  readonly version: string;
  readonly sourceSha256: string;
  readonly wasm: ArtifactMetadata;
  readonly glue: ArtifactMetadata;
  readonly notices: ArtifactMetadata;
  readonly goModule: { readonly sha256: string };
  readonly toolchain: string;
  readonly flags: readonly string[];
  readonly modules: readonly StarterModule[];
}

export async function readManifest(
  distDirectory: string = dirname(fileURLToPath(import.meta.url)),
): Promise<StarterManifest> {
  const manifest = JSON.parse(
    await readFile(join(distDirectory, 'manifest.json'), 'utf8'),
  ) as StarterManifest;
  const digest = (value: unknown): boolean =>
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const artifact = (value: ArtifactMetadata | undefined): boolean =>
    value !== undefined &&
    digest(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0;
  if (
    typeof manifest.version !== 'string' ||
    !digest(manifest.sourceSha256) ||
    !digest(manifest.goModule?.sha256) ||
    !artifact(manifest.wasm) ||
    !artifact(manifest.glue) ||
    !artifact(manifest.notices) ||
    typeof manifest.toolchain !== 'string' ||
    !Array.isArray(manifest.flags) ||
    !manifest.flags.every((flag) => typeof flag === 'string') ||
    !Array.isArray(manifest.modules) ||
    !manifest.modules.every(
      (module) =>
        typeof module.path === 'string' &&
        typeof module.version === 'string' &&
        typeof module.license === 'string',
    )
  )
    throw new Error(invalidArtifact);
  return manifest;
}
