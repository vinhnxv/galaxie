// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash, type Hash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Names that are never Go inputs. Hidden and underscore-prefixed paths stay in the hash. */
const ignoredNames: ReadonlySet<string> = new Set(['.git', '.DS_Store', 'node_modules']);

/** Hash regular files in relative POSIX order, preserving their exact bytes. */
async function updateTree(directory: string, hash: Hash): Promise<void> {
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error('The Go source tree root is a symlink.');
  const files: string[] = [];
  async function walk(prefix: string): Promise<void> {
    for (const name of await readdir(join(directory, prefix))) {
      const path = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(join(directory, path));
      if (info.isSymbolicLink()) throw new Error(`The Go source tree contains a symlink: ${path}`);
      if (ignoredNames.has(name)) continue;
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) files.push(path);
      else throw new Error(`The Go source tree contains a non-regular file: ${path}`);
    }
  }
  await walk('');
  for (const path of files.sort()) {
    const bytes = await readFile(join(directory, path));
    hash.update(`${path}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
}

export async function hashTree(directory: string): Promise<string> {
  const hash = createHash('sha256');
  await updateTree(directory, hash);
  return hash.digest('hex');
}

/** One identity shared by packing and project builds, including local module changes. */
export async function sourceHash(
  directory: string,
  version: string,
  moduleSha256: string,
): Promise<string> {
  const hash = createHash('sha256');
  await updateTree(directory, hash);
  return hash.update(`${version}\0${moduleSha256}`).digest('hex');
}
