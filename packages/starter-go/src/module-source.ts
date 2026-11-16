// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

/** Copy only the redistributable module and runtime source, including bridge subpackages. */
export async function copyModuleSource(
  repositoryGoDirectory: string,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const name of ['go.mod', 'go.sum'])
    await cp(join(repositoryGoDirectory, name), join(destination, name));
  const source = join(repositoryGoDirectory, 'galaxie');
  for (const entry of await readdir(source, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.go') || entry.name.endsWith('_test.go')) continue;
    const path = relative(source, join(entry.parentPath, entry.name));
    const target = join(destination, 'galaxie', path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(entry.parentPath, entry.name), target);
  }
}
