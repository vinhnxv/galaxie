// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LockedWheel {
  readonly name: string;
  readonly version: string;
  readonly url: string;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly frameworks?: readonly ('langgraph' | 'pydantic-ai' | 'dspy' | 'adk')[];
}

export interface PythonLock {
  readonly v: 'galaxie.python-lock/v1';
  readonly pyodide: '314.0.7';
  readonly packages: readonly LockedWheel[];
}

const invalidWheel = 'The Python wheel could not be verified.';

function matches(bytes: Uint8Array, wheel: LockedWheel): boolean {
  return (
    bytes.byteLength === wheel.bytes &&
    createHash('sha256').update(bytes).digest('hex') === wheel.sha256
  );
}

export async function fetchWheel(
  wheel: LockedWheel,
  directory: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (basename(wheel.file) !== wheel.file || !wheel.file.endsWith('.whl'))
    throw new Error(invalidWheel);
  const path = join(directory, wheel.file);
  try {
    if (matches(await readFile(path), wheel)) return;
    await rm(path, { force: true });
  } catch {}
  try {
    const source = new URL(wheel.url, import.meta.url);
    let bytes: Uint8Array;
    if (source.protocol === 'file:') {
      const vendored = new URL(`../python/wheels/${wheel.file}`, import.meta.url);
      if (source.href !== vendored.href) throw new Error(invalidWheel);
      bytes = new Uint8Array(await readFile(source));
    } else {
      const response = await fetcher(wheel.url, { credentials: 'omit' });
      if (!response.ok) throw new Error(invalidWheel);
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    if (!matches(bytes, wheel)) throw new Error(invalidWheel);
    await mkdir(directory, { recursive: true });
    await writeFile(path, bytes);
  } catch {
    throw new Error(invalidWheel);
  }
}

export async function fetchPythonWheels(): Promise<void> {
  const lock = JSON.parse(
    await readFile(new URL('../python/requirements.lock', import.meta.url), 'utf8'),
  ) as PythonLock;
  const directory = fileURLToPath(new URL('../.cache/python-wheels/', import.meta.url));
  for (const wheel of lock.packages) await fetchWheel(wheel, directory);
  console.log(
    `Verified ${lock.packages.length} Python wheels (${lock.packages.reduce((sum, wheel) => sum + wheel.bytes, 0)} bytes).`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fetchPythonWheels();
}
