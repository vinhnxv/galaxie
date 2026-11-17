// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { readTarballManifest, TarballError } from './tarball.js';

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
export { TarballError } from './tarball.js';

export function requiredPackages(framework: string): readonly string[] {
  if (framework === 'langgraph-python')
    return [...knownPackages, '@galaxie-ai/adapter-pyodide', '@galaxie-ai/starter-python'];
  if (framework === 'adk-go')
    return [...knownPackages, '@galaxie-ai/adapter-go', '@galaxie-ai/starter-go'];
  return framework === 'adk-js' ? [...knownPackages, '@galaxie-ai/adapter-adk'] : knownPackages;
}

export async function resolveTarballs(
  directory: string,
  framework = 'langgraph-js',
): Promise<Tarballs> {
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
  for (const name of requiredPackages(framework)) {
    const prefix = name.replace('@galaxie-ai/', 'galaxie-ai-');
    const pattern = new RegExp(`^${prefix}-(\\d+\\.\\d+\\.\\d+(?:[-+][a-zA-Z0-9.-]+)?)\\.tgz$`);
    const matches = entries.filter((entry) => pattern.test(entry));
    if (matches.length !== 1) throw new TarballError(`Expected exactly one tarball for ${name}.`);
    const full = join(directory, matches[0] as string);
    const stat = await lstat(full);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new TarballError(`Expected a regular tarball for ${name}.`);
    const manifest = await readTarballManifest(full, name);
    const version = pattern.exec(matches[0] as string)?.[1];
    for (const [field, expected] of [
      ['name', name],
      ['version', version],
    ] as const)
      if (manifest[field] !== expected)
        throw new TarballError(
          `${name}: tarball package.json ${field} mismatch; expected ${expected}, received ${JSON.stringify(manifest[field]) ?? 'missing'}.`,
        );
    result.set(name, full);
  }
  return result;
}
