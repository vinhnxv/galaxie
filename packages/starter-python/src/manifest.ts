// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invalidArtifact } from './errors.js';

export interface ArtifactMetadata {
  readonly bytes: number;
  readonly sha256: string;
}
export interface RuntimeFile extends ArtifactMetadata {
  readonly file: string;
}
export interface StarterWheel extends RuntimeFile {
  readonly name: string;
  readonly version: string;
  readonly license: string;
}
export interface StarterManifest {
  readonly version: string;
  readonly pyodideVersion: string;
  readonly wheels: readonly StarterWheel[];
  readonly runtimeFiles: readonly RuntimeFile[];
  readonly notices: ArtifactMetadata;
}

export function validArtifact(value: unknown): value is ArtifactMetadata {
  if (value === null || typeof value !== 'object') return false;
  const artifact = value as ArtifactMetadata;
  return (
    Number.isSafeInteger(artifact.bytes) &&
    artifact.bytes > 0 &&
    typeof artifact.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(artifact.sha256)
  );
}

export function validFileName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(value);
}

export async function readManifest(
  distDirectory: string = dirname(fileURLToPath(import.meta.url)),
): Promise<StarterManifest> {
  try {
    if (!(await lstat(join(distDirectory, 'manifest.json'))).isFile())
      throw new Error(invalidArtifact);
    const manifest = JSON.parse(
      await readFile(join(distDirectory, 'manifest.json'), 'utf8'),
    ) as StarterManifest;
    const file = (value: RuntimeFile): boolean => validArtifact(value) && validFileName(value.file);
    if (
      typeof manifest?.version !== 'string' ||
      typeof manifest.pyodideVersion !== 'string' ||
      !validArtifact(manifest.notices) ||
      !Array.isArray(manifest.wheels) ||
      manifest.wheels.length === 0 ||
      !manifest.wheels.every(
        (wheel: StarterWheel) =>
          file(wheel) &&
          wheel.file.endsWith('.whl') &&
          typeof wheel.name === 'string' &&
          typeof wheel.version === 'string' &&
          typeof wheel.license === 'string',
      ) ||
      !Array.isArray(manifest.runtimeFiles) ||
      manifest.runtimeFiles.length === 0 ||
      !manifest.runtimeFiles.every(file) ||
      new Set(manifest.wheels.map((wheel) => wheel.file)).size !== manifest.wheels.length ||
      new Set(manifest.runtimeFiles.map((runtime) => runtime.file)).size !==
        manifest.runtimeFiles.length
    )
      throw new Error(invalidArtifact);
    return manifest;
  } catch {
    throw new Error(invalidArtifact);
  }
}
