// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { unzipSync } from 'fflate';

export async function verifyWheelSources(
  wheel: {
    readonly file: string;
    readonly bytes: Uint8Array;
    readonly pyprojectSha256: string | undefined;
  },
  repositoryRoot: string,
  packagePath: string,
): Promise<void> {
  const sourceDirectory = join(repositoryRoot, packagePath, 'src');
  const message = `The Python starter wheel does not match ${packagePath}/src: ${wheel.file}. Rebuild with: node scripts/build-python-wheels.ts`;
  try {
    const entries = unzipSync(wheel.bytes, { filter: ({ name }) => name.endsWith('.py') });
    const files = (await readdir(sourceDirectory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.name.endsWith('.py'))
      .map((entry) => ({
        entry,
        path: relative(sourceDirectory, join(entry.parentPath, entry.name)).split(sep).join('/'),
      }));
    if (
      JSON.stringify(Object.keys(entries).sort()) !==
      JSON.stringify(files.map(({ path }) => path).sort())
    )
      throw new Error(message);
    for (const { entry, path } of files) {
      if (!entry.isFile()) throw new Error(message);
      const source = await readFile(join(sourceDirectory, path));
      if (!source.equals(entries[path] ?? new Uint8Array())) throw new Error(message);
    }
  } catch (cause) {
    throw new Error(message, { cause });
  }
  const metadataMessage = `The Python starter wheel does not match ${packagePath}/pyproject.toml: ${wheel.file}. Rebuild with: node scripts/build-python-wheels.ts`;
  try {
    const metadata = await readFile(join(repositoryRoot, packagePath, 'pyproject.toml'));
    if (createHash('sha256').update(metadata).digest('hex') !== wheel.pyprojectSha256)
      throw new Error(metadataMessage);
  } catch (cause) {
    throw new Error(metadataMessage, { cause });
  }
}
