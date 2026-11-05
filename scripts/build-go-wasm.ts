// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheDirectory, goEnvironment, readGoWasmLock, runGo } from './go-wasm-lock.ts';

export interface GoWasmBuild {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Builds one wasm main package with the locked flags; the output is byte-reproducible. */
export async function buildGoWasm(
  packagePath: string,
  output: string = join(
    cacheDirectory,
    `${packagePath.replace(/^\.\//, '').replaceAll('/', '-')}.wasm`,
  ),
): Promise<GoWasmBuild> {
  const lock = await readGoWasmLock();
  const toolchain = runGo(['env', 'GOVERSION'], goEnvironment(lock)).trim();
  if (toolchain !== lock.toolchain)
    throw new Error(`The Go toolchain is ${toolchain}; go/wasm.lock pins ${lock.toolchain}.`);
  await mkdir(dirname(output), { recursive: true });
  runGo(
    ['build', `-ldflags=${lock.build.ldflags}`, '-o', output, packagePath],
    goEnvironment(lock),
  );
  const bytes = await readFile(output);
  return {
    file: output,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (target === undefined) throw new Error('Name the Go package to build, for example ./gate.');
  const built = await buildGoWasm(target, process.argv[3]);
  console.log(`${built.file} ${built.bytes} bytes sha256:${built.sha256}`);
}
