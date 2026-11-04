// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cacheDirectory,
  type GoWasmLock,
  goEnvironment,
  readGoWasmLock,
  runGo,
} from './go-wasm-lock.ts';

export const invalidGlue = 'The Go glue file could not be verified.';

function matches(bytes: Uint8Array, glue: GoWasmLock['glue']): boolean {
  return (
    bytes.byteLength === glue.bytes &&
    createHash('sha256').update(bytes).digest('hex') === glue.sha256
  );
}

/** Copies the toolchain's glue file into the cache after its digest matches the lock. */
export async function fetchGoGlue(
  goroot: string = runGo(['env', 'GOROOT'], goEnvironment()).trim(),
  directory: string = cacheDirectory,
): Promise<string> {
  const lock = await readGoWasmLock();
  let bytes: Uint8Array;
  try {
    bytes = await readFile(join(goroot, 'lib/wasm', lock.glue.file));
  } catch {
    throw new Error(invalidGlue);
  }
  if (!matches(bytes, lock.glue)) throw new Error(invalidGlue);
  await mkdir(directory, { recursive: true });
  const target = join(directory, lock.glue.file);
  await writeFile(target, bytes);
  return target;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Verified ${await fetchGoGlue()}.`);
}
