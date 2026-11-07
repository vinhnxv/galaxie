// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export interface Size {
  readonly minified: number;
  readonly gzip: number;
}

export interface SizeBudget {
  readonly marginPercent: number;
  readonly entries: Readonly<Record<string, Size>>;
}

export interface PackageEntry {
  readonly entry: string;
  readonly directory: string;
  readonly file: string;
}

interface Manifest {
  readonly name: string;
  readonly private?: boolean;
  readonly exports: Readonly<Record<string, { readonly default: string }>>;
}

export interface SizeRow {
  readonly entry: string;
  readonly minified: number | undefined;
  readonly gzip: number | undefined;
  readonly minifiedBudget: number | undefined;
  readonly gzipBudget: number | undefined;
  readonly status: 'pass' | 'fail' | 'missing budget' | 'stale budget';
}

/** Discover launch packages from manifests, including every default JavaScript export. */
export function discoverEntries(packagesDirectory: string): PackageEntry[] {
  const entries: PackageEntry[] = [];
  for (const name of readdirSync(packagesDirectory).sort()) {
    const directory = resolve(packagesDirectory, name);
    const manifestPath = join(directory, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    if (manifest.private === true) continue;
    if (manifest.exports === undefined)
      throw new Error(`${manifest.name}: missing package exports.`);
    for (const [subpath, conditions] of Object.entries(manifest.exports)) {
      const entry = `${manifest.name}/${subpath === '.' ? '.' : subpath.slice(2)}`;
      const target = conditions.default;
      if (!target?.startsWith('./dist/') || !/\.[cm]?js$/.test(target))
        throw new Error(`${entry}: expected a default JavaScript export under dist/.`);
      entries.push({ entry, directory, file: resolve(directory, target) });
    }
  }
  return entries.sort((left, right) =>
    left.entry < right.entry ? -1 : left.entry > right.entry ? 1 : 0,
  );
}

/** Compare both byte counts, including missing and stale budget entries. */
export function compareSizes(
  measured: Readonly<Record<string, Size>>,
  budget: SizeBudget,
): { rows: SizeRow[]; failures: string[] } {
  const rows: SizeRow[] = [];
  const failures: string[] = [];
  const entries = [...new Set([...Object.keys(measured), ...Object.keys(budget.entries)])].sort();
  for (const entry of entries) {
    const size = measured[entry];
    const limit = budget.entries[entry];
    let status: SizeRow['status'] = 'pass';
    if (size === undefined) {
      status = 'stale budget';
      failures.push(`${entry}: stale budget entry is not measured.`);
    } else if (limit === undefined) {
      status = 'missing budget';
      failures.push(`${entry}: missing size budget.`);
    } else {
      for (const metric of ['minified', 'gzip'] as const) {
        if (size[metric] > limit[metric]) {
          status = 'fail';
          failures.push(
            `${entry}: ${metric} ${size[metric]} bytes exceeds the ${limit[metric]} byte limit.`,
          );
        }
      }
    }
    rows.push({
      entry,
      minified: size?.minified,
      gzip: size?.gzip,
      minifiedBudget: limit?.minified,
      gzipBudget: limit?.gzip,
      status,
    });
  }
  return { rows, failures };
}

/** Add the configured margin and round each limit up to a multiple of 100 bytes. */
export function createBudget(
  measured: Readonly<Record<string, Size>>,
  marginPercent: number,
): SizeBudget {
  const limit = (bytes: number): number =>
    Math.ceil((bytes * (100 + marginPercent)) / 10_000) * 100;
  return {
    marginPercent,
    entries: Object.fromEntries(
      Object.keys(measured)
        .sort()
        .map((entry) => {
          const size = measured[entry];
          if (size === undefined) throw new Error(`${entry}: missing measurement.`);
          return [entry, { minified: limit(size.minified), gzip: limit(size.gzip) }];
        }),
    ),
  };
}

/** Measure package-owned code; every bare import remains external. */
export async function measureEntry(entry: PackageEntry): Promise<Size & { readonly code: string }> {
  if (!existsSync(entry.file))
    throw new Error(`${entry.entry}: missing ${entry.file}; run pnpm run build:packages first.`);
  // Loading Vite here keeps comparison and budget generation usable without the bundler.
  const { build } = await import('vite');
  const result = await build({
    configFile: false,
    envFile: false,
    root: entry.directory,
    publicDir: false,
    plugins: [],
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    build: {
      write: false,
      minify: true,
      sourcemap: false,
      copyPublicDir: false,
      lib: { entry: entry.file, formats: ['es'], fileName: 'entry' },
      rolldownOptions: {
        external: (specifier) => !specifier.startsWith('.') && !isAbsolute(specifier),
        output: { codeSplitting: false },
      },
    },
  });
  const chunks: string[] = [];
  for (const output of Array.isArray(result) ? result : [result]) {
    if (!('output' in output)) throw new Error(`${entry.entry}: expected an in-memory bundle.`);
    for (const chunk of output.output) {
      if (chunk.type === 'chunk') chunks.push(chunk.code);
    }
  }
  if (chunks.length !== 1)
    throw new Error(`${entry.entry}: expected one JavaScript chunk, received ${chunks.length}.`);
  const code = chunks[0];
  if (code === undefined) throw new Error(`${entry.entry}: missing JavaScript output.`);
  return {
    code,
    minified: Buffer.byteLength(code),
    gzip: gzipSync(code, { level: 9 }).byteLength,
  };
}

export async function measureSizes(
  entries: readonly PackageEntry[],
): Promise<Record<string, Size>> {
  const measured: Record<string, Size> = {};
  for (const entry of entries) {
    const { minified, gzip } = await measureEntry(entry);
    measured[entry.entry] = { minified, gzip };
  }
  return measured;
}

function readBudget(file: string): SizeBudget {
  const budget = JSON.parse(readFileSync(file, 'utf8')) as SizeBudget;
  if (
    !Number.isFinite(budget.marginPercent) ||
    budget.marginPercent < 0 ||
    budget.entries === null ||
    typeof budget.entries !== 'object' ||
    Array.isArray(budget.entries)
  )
    throw new Error(`${file}: expected a non-negative marginPercent and an entries object.`);
  for (const [entry, limits] of Object.entries(budget.entries)) {
    if (
      limits === null ||
      !Number.isSafeInteger(limits.minified) ||
      limits.minified < 0 ||
      !Number.isSafeInteger(limits.gzip) ||
      limits.gzip < 0
    )
      throw new Error(`${entry}: minified and gzip budgets must be non-negative integer bytes.`);
  }
  return budget;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--write'))
    throw new Error('Usage: node scripts/check-size.ts [--write]');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const file = join(root, 'scripts/size-budget.json');
  const budget = readBudget(file);
  const measured = await measureSizes(discoverEntries(join(root, 'packages')));
  if (args[0] === '--write') {
    writeFileSync(
      file,
      `${JSON.stringify(createBudget(measured, budget.marginPercent), null, 2)}\n`,
    );
    console.log(`Wrote ${Object.keys(measured).length} entry budgets to scripts/size-budget.json.`);
    return;
  }
  const { rows, failures } = compareSizes(measured, budget);
  console.table(rows);
  if (failures.length > 0) {
    console.error(`Size check failed:\n${failures.join('\n')}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`Size check failed: ${String(error)}`);
    process.exitCode = 1;
  }
}
