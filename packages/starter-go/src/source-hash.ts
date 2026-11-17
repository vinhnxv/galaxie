// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash, type Hash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Names that are never Go inputs. Hidden and underscore-prefixed paths stay in the hash. */
const ignoredNames: ReadonlySet<string> = new Set(['.git', '.DS_Store', 'node_modules']);

/** Local replacements must refer to inputs covered by the source identity. */
export async function checkReplacements(directory: string): Promise<void> {
  const text = await readFile(join(directory, 'go.mod'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    },
  );
  // Keep quoted paths whole and discard only Go module line comments.
  const tokens = (text.match(/\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|`[^`]*`|[^\s()]+/g) ?? []).filter(
    (token) => !token.startsWith('//'),
  );
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] !== '=>') continue;
    let target = tokens[index + 1] ?? '';
    if (target.startsWith('"')) {
      try {
        target = JSON.parse(target) as string;
      } catch {
        throw new Error(`The Go starter replace target uses unsupported quoting: ${target}.`);
      }
    } else if (target.startsWith('`')) target = target.slice(1, -1);
    // Versioned module replacements are checked by Go and go.sum.
    if (!target.startsWith('.') && !isAbsolute(target) && !target.includes('\\')) continue;
    const path = resolve(directory, target);
    if (path === resolve(directory, '../node_modules/@galaxie-ai/starter-go/dist/go-module'))
      continue;
    const local = relative(resolve(directory), path);
    if (
      target.includes('\\') ||
      isAbsolute(local) ||
      local.split(sep).some((part) => part === '..' || ignoredNames.has(part))
    )
      throw new Error(
        `The Go starter local replace target must be inside go/ or the bundled starter-go module: ${target}.`,
      );
  }
}

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
  await checkReplacements(directory);
  const hash = createHash('sha256');
  await updateTree(directory, hash);
  return hash.update(`${version}\0${moduleSha256}`).digest('hex');
}
