// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const knownPackages: readonly string[] = [
  '@galaxie-ai/ui-protocol',
  '@galaxie-ai/core',
  '@galaxie-ai/adapter-kit',
  '@galaxie-ai/adapter-langgraph',
  '@galaxie-ai/models',
  '@galaxie-ai/storage-indexeddb',
  '@galaxie-ai/react',
];
export type Tarballs = ReadonlyMap<string, string>;
export type PackageManager = 'npm' | 'pnpm' | 'yarn';
export class TarballError extends Error {}

export async function resolveTarballs(directory: string): Promise<Tarballs> {
  if (!isAbsolute(directory)) throw new TarballError('The tarball directory must be absolute.');
  let entries: string[];
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    entries = await readdir(directory);
  } catch {
    throw new TarballError('The tarball directory must exist and be a real directory.');
  }
  const result = new Map<string, string>();
  for (const name of knownPackages) {
    const prefix = name.replace('@galaxie-ai/', 'galaxie-ai-');
    const pattern = new RegExp(`^${prefix}-(\\d+\\.\\d+\\.\\d+(?:[-+][a-zA-Z0-9.-]+)?)\\.tgz$`);
    const matches = entries.filter((entry) => pattern.test(entry));
    if (matches.length !== 1) throw new TarballError(`Expected exactly one tarball for ${name}.`);
    const full = join(directory, matches[0] as string);
    const stat = await lstat(full);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new TarballError(`Expected a regular tarball for ${name}.`);
    result.set(name, full);
  }
  return result;
}
