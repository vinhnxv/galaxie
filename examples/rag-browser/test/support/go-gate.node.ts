// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGoWasm } from '../../../../scripts/build-go-wasm.ts';
import { fetchGoGlue } from '../../../../scripts/fetch-go-glue.ts';
import { goInstalled } from '../../../../scripts/go-wasm-lock.ts';

export const goAvailable: boolean = goInstalled();
export const missingGo: string =
  'Go is not installed; install the toolchain named in go/go.mod to run the Go gate.';
if (!goAvailable && process.env['CI']) throw new Error(missingGo);

export const gateRoot: string = fileURLToPath(new URL('./go-gate/', import.meta.url));
/** The size ceiling for the raw module, and the cold-start ceiling in milliseconds. */
export const maxWasmBytes: number = 48 * 1024 * 1024;
export const maxColdStartMs: number = 10_000;

export interface BuiltGate {
  readonly directory: string;
  readonly wasm: { readonly url: string; readonly sha256: string; readonly bytes: number };
  readonly file: string;
  readonly expected: Record<string, unknown>;
}

let built: Promise<BuiltGate> | undefined;

/** Verifies the glue file, builds the gate module with the locked flags and loads the records. */
export function buildGate(): Promise<BuiltGate> {
  built ??= (async () => {
    if (!goAvailable) throw new Error(missingGo);
    await fetchGoGlue();
    const directory = await mkdtemp(join(tmpdir(), 'galaxie-go-gate-'));
    await mkdir(join(directory, 'public/go'), { recursive: true });
    const output = join(directory, 'public/go/gate.wasm');
    const module = await buildGoWasm('./gate', output);
    const expected = JSON.parse(
      await readFile(new URL('../../../../go/gate/expected.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    return {
      directory,
      file: output,
      wasm: { url: '/go/gate.wasm', sha256: module.sha256, bytes: module.bytes },
      expected,
    };
  })();
  return built;
}
