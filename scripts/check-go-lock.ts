// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  byPath,
  type GoWasmLock,
  goEnvironment,
  type LockedGoModule,
  lockUrl,
  readGoWasmLock,
  runGo,
  wasmModules,
} from './go-wasm-lock.ts';

const cutoff = '2026-10-28T00:00:00Z';
const goPackages = ['./gate'];

/** The sumdb record number of one module version: the first line of its lookup answer. */
async function sumdbRecord(path: string, version: string): Promise<number> {
  const escaped = path.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
  const response = await fetch(`https://sum.golang.org/lookup/${escaped}@${version}`);
  if (!response.ok) throw new Error(`The checksum database has no record of ${path}@${version}.`);
  const record = Number((await response.text()).split('\n')[0]);
  if (!Number.isSafeInteger(record))
    throw new Error(`The record of ${path}@${version} is invalid.`);
  return record;
}

/** The record number of the first version the public module index lists at or after the cutoff. */
async function cutoffRecord(): Promise<number> {
  const response = await fetch(`https://index.golang.org/index?since=${cutoff}&limit=1`);
  const entry = JSON.parse((await response.text()).split('\n')[0] ?? '') as {
    Path: string;
    Version: string;
  };
  return sumdbRecord(entry.Path, entry.Version);
}

/** Classifies a license file; an unknown text is recorded as such and fails the lock test. */
export function classifyLicense(text: string): string {
  const body = text.replace(/\s+/g, ' ');
  if (/Apache License,? Version 2\.0/i.test(body)) return 'Apache-2.0';
  if (/Permission is hereby granted, free of charge/i.test(body)) return 'MIT';
  if (/Permission to use, copy, modify, and\/or distribute this software/i.test(body)) return 'ISC';
  if (/Redistribution and use in source and binary forms/i.test(body)) {
    return /Neither the name|may be used to endorse/i.test(body) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  }
  return 'UNKNOWN';
}

async function licenseOf(directory: string): Promise<string> {
  const names = (await readdir(directory)).filter((name) => /^(LICEN[SC]E|COPYING)/i.test(name));
  for (const name of names.sort()) {
    const license = classifyLicense(await readFile(join(directory, name), 'utf8'));
    if (license !== 'UNKNOWN') return license;
  }
  return 'UNKNOWN';
}

export async function updateGoWasmLock(): Promise<void> {
  const previous = await readGoWasmLock().catch(() => undefined);
  const toolchain = runGo(['env', 'GOVERSION'], goEnvironment()).trim();
  const wasm = wasmModules({ packages: goPackages });
  const modules: LockedGoModule[] = [];
  for (const { path, version } of wasm) {
    const info = JSON.parse(
      runGo(['list', '-m', '-json', `${path}@${version}`], goEnvironment()),
    ) as { Time: string; Dir: string };
    modules.push({
      path,
      version,
      license: await licenseOf(info.Dir),
      time: info.Time,
      sumdbRecord: await sumdbRecord(path, version),
    });
  }
  const goroot = runGo(['env', 'GOROOT'], goEnvironment()).trim();
  const glue = await readFile(join(goroot, 'lib/wasm/wasm_exec.js'));
  const { createHash } = await import('node:crypto');
  const lock: GoWasmLock = {
    v: 'galaxie.go-wasm-lock/v1',
    toolchain,
    build: {
      goos: 'js',
      goarch: 'wasm',
      cgo: '0',
      flags: ['-trimpath'],
      ldflags: '-s -w -buildid=',
    },
    packages: goPackages,
    cutoff,
    cutoffRecord: previous?.cutoffRecord ?? (await cutoffRecord()),
    glue: {
      file: 'wasm_exec.js',
      sha256: createHash('sha256').update(glue).digest('hex'),
      bytes: glue.byteLength,
    },
    modules: modules.sort(byPath),
  };
  await writeFile(lockUrl, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Locked ${modules.length} Go modules for the wasm build (${toolchain}).`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--update')) await updateGoWasmLock();
  else throw new Error('Run with --update to regenerate go/wasm.lock; the lock test verifies it.');
}
