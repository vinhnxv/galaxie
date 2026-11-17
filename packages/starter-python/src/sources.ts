// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { unzipSync } from 'fflate';

/** Check packaged Python modules against the checkout without rebuilding the wheel. */
export async function verifyWheelSources(
  wheel: { readonly file: string; readonly bytes: Uint8Array },
  sourceDirectory: string,
): Promise<void> {
  const message = `The Python starter wheel does not match python/galaxie/src: ${wheel.file}. Rebuild with: node scripts/build-python-wheels.ts`;
  try {
    const entries = unzipSync(wheel.bytes, { filter: ({ name }) => name.endsWith('.py') });
    const files = (await readdir(sourceDirectory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.name.endsWith('.py'))
      .map((entry) => ({
        entry,
        path: relative(sourceDirectory, join(entry.parentPath, entry.name)).split(sep).join('/'),
      }))
      .filter(({ path }) => !path.split('/').includes('__pycache__'));
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
  } catch {
    throw new Error(message);
  }
}
