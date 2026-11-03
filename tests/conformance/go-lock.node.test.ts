// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { buildGoWasm } from '../../scripts/build-go-wasm.ts';
import { classifyLicense } from '../../scripts/check-go-lock.ts';
import { fetchGoGlue, invalidGlue } from '../../scripts/fetch-go-glue.ts';
import {
  allowedLicenses,
  goDirectory,
  goEnvironment,
  goInstalled,
  readGoWasmLock,
  runGo,
  wasmModules,
} from '../../scripts/go-wasm-lock.ts';

const missingGo = 'The Go toolchain is not installed; install Go to run the Go lock checks.';

test('every locked module is licensed for redistribution and verified before the cutoff', async () => {
  const lock = await readGoWasmLock();
  expect(lock.modules.length).toBeGreaterThan(0);
  expect(Number.isSafeInteger(lock.cutoffRecord)).toBe(true);
  for (const module of lock.modules) {
    expect(allowedLicenses, module.path).toContain(module.license);
    // A version the checksum database recorded after the cutoff version cannot be in the lock.
    expect(module.sumdbRecord, module.path).toBeLessThan(lock.cutoffRecord);
    expect(module.version, module.path).toMatch(/^v\d/);
  }
  expect(new Set(lock.modules.map((module) => module.path)).size).toBe(lock.modules.length);
  expect(classifyLicense('Some private terms')).toBe('UNKNOWN');
});

test('go.sum has both hashes of every locked module', async () => {
  const lock = await readGoWasmLock();
  const sum = await readFile(join(goDirectory, 'go.sum'), 'utf8');
  for (const module of lock.modules) {
    expect(sum, module.path).toContain(`${module.path} ${module.version} h1:`);
    expect(sum, module.path).toContain(`${module.path} ${module.version}/go.mod h1:`);
  }
});

test.skipIf(!goInstalled())(
  goInstalled() ? 'the lock covers exactly the modules the wasm build compiles' : missingGo,
  async () => {
    const lock = await readGoWasmLock();
    expect(lock.toolchain).toBe(runGo(['env', 'GOVERSION'], goEnvironment()).trim());
    expect(wasmModules(lock)).toEqual(lock.modules.map(({ path, version }) => ({ path, version })));
  },
);

test.skipIf(!goInstalled())(
  goInstalled() ? 'the glue file matches the lock and a one-byte change fails' : missingGo,
  async () => {
    const lock = await readGoWasmLock();
    const directory = await mkdtemp(join(tmpdir(), 'galaxie-go-glue-'));
    try {
      const goroot = runGo(['env', 'GOROOT'], goEnvironment()).trim();
      const target = await fetchGoGlue(goroot, join(directory, 'out'));
      const bytes = await readFile(target);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(lock.glue.sha256);
      expect(bytes.byteLength).toBe(lock.glue.bytes);
      const fake = join(directory, 'root');
      await mkdir(join(fake, 'lib/wasm'), { recursive: true });
      await cp(join(goroot, 'lib/wasm/wasm_exec.js'), join(fake, 'lib/wasm/wasm_exec.js'));
      const changed = new Uint8Array(bytes);
      changed[0] = (changed[0] ?? 0) ^ 1;
      await writeFile(join(fake, 'lib/wasm/wasm_exec.js'), changed);
      await expect(fetchGoGlue(fake, join(directory, 'rejected'))).rejects.toThrow(invalidGlue);
      await expect(
        fetchGoGlue(join(directory, 'missing'), join(directory, 'rejected')),
      ).rejects.toThrow(invalidGlue);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(!goInstalled())(
  goInstalled() ? 'two builds of the gate are byte-identical' : missingGo,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'galaxie-go-build-'));
    try {
      const first = await buildGoWasm('./gate', join(directory, 'one/gate.wasm'));
      const second = await buildGoWasm('./gate', join(directory, 'two/gate.wasm'));
      expect(first.sha256).toBe(second.sha256);
      expect(first.bytes).toBe(second.bytes);
      expect(first.bytes).toBeGreaterThan(1_000_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  300000,
);
