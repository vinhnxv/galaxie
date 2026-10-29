// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Manifest {
  readonly version: string;
  readonly entry: string;
  readonly skills?: readonly string[];
}

export interface ManifestOptions<Definition> {
  readonly packageDir: string;
  readonly definition: Definition;
  readonly createManifest: (
    definition: Definition,
    options: { entry: string },
  ) => {
    manifest: Manifest;
    schemas: Readonly<Record<string, unknown>>;
  };
}

class ManifestBuildError extends Error {}

function invalidPaths(): never {
  throw new ManifestBuildError('The package paths are invalid.');
}

function mismatch(path: string): never {
  throw new ManifestBuildError(`Manifest mismatch: ${path}`);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ManifestBuildError('The package metadata is invalid.');
  return value as Record<string, unknown>;
}

function packagePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('./') ||
    /[\\:]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    value.split('/').includes('..')
  )
    invalidPaths();
  const parts = value.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0) invalidPaths();
  return `./${parts.join('/')}`;
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ManifestBuildError('Manifest operation failed.');
  }
}

/** Do not follow package symlinks, including an existing output directory. */
function localPath(packageDir: string, path: string): string {
  const full = resolve(packageDir, path);
  if (!inside(packageDir, full)) invalidPaths();
  let current = packageDir;
  for (const part of relative(packageDir, full).split(sep)) {
    current = join(current, part);
    if (stat(current)?.isSymbolicLink()) invalidPaths();
  }
  return full;
}

function metadata(packageDir: string): {
  packageDir: string;
  entry: string;
  out: string;
  exportName: string;
  version: string;
  files: string[];
} {
  const root = realpathSync(packageDir);
  const pkg = record(JSON.parse(readFileSync(localPath(root, './package.json'), 'utf8')));
  const config = record(pkg['galaxie']);
  const entry = packagePath(config['definition']);
  const out = packagePath(config['out']);
  if (
    typeof config['export'] !== 'string' ||
    config['export'].length === 0 ||
    typeof pkg['version'] !== 'string' ||
    !Array.isArray(pkg['files'])
  )
    throw new ManifestBuildError('The package metadata is invalid.');
  const files = pkg['files'].map((file: unknown) => {
    if (typeof file !== 'string') invalidPaths();
    return packagePath(file.startsWith('./') ? file : `./${file}`);
  });
  const output = localPath(root, out);
  // The parent must already exist: even recursive creation may write only inside output.
  try {
    if (!inside(root, realpathSync(dirname(output)))) invalidPaths();
  } catch {
    invalidPaths();
  }
  if (stat(output) !== undefined && !stat(output)?.isDirectory()) invalidPaths();
  if (
    !files.some((file) => {
      const directory = localPath(root, file);
      return stat(directory)?.isDirectory() && inside(directory, output);
    })
  )
    invalidPaths();
  if (entry === out || inside(output, resolve(root, entry))) invalidPaths();
  return {
    packageDir: root,
    entry,
    out,
    exportName: config['export'],
    version: pkg['version'],
    files,
  };
}

function digest(packageDir: string, path: string): string {
  const full = localPath(packageDir, path);
  if (!stat(full)?.isFile()) mismatch(path);
  return hash(readFileSync(full));
}

function hash(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

function lockfile(packageDir: string): string {
  let directory = packageDir;
  while (true) {
    const path = join(directory, 'pnpm-lock.yaml');
    const info = stat(path);
    if (info !== undefined) {
      if (!info.isFile() || info.isSymbolicLink()) invalidPaths();
      return path;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new ManifestBuildError('The lockfile is missing.');
    directory = parent;
  }
}

function inventory(packageDir: string, roots: readonly string[], excluded?: string): string[] {
  const paths = new Set<string>();
  const visit = (path: string): void => {
    const full = localPath(packageDir, path);
    if (excluded !== undefined && (full === excluded || inside(excluded, full))) return;
    const info = stat(full);
    if (info?.isDirectory()) {
      for (const name of readdirSync(full).sort()) visit(`${path}/${name}`);
    } else if (info?.isFile()) paths.add(path);
    else mismatch(path);
  };
  for (const path of roots) visit(path);
  return [...paths].sort();
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function prepare<Definition>(options: ManifestOptions<Definition>): {
  packageDir: string;
  entry: string;
  out: string;
  lock: string;
  files: Record<string, string>;
  artifacts: Record<string, string>;
  integrity: { entry: string; files: Record<string, string>; lockfile: string };
} {
  const pkg = metadata(options.packageDir);
  const { manifest, schemas } = options.createManifest(options.definition, { entry: pkg.entry });
  if (manifest.version !== pkg.version)
    throw new ManifestBuildError('The definition version must match the package version.');
  const output = resolve(pkg.packageDir, pkg.out);
  const skills = (manifest.skills ?? []).map(packagePath);
  for (const skill of skills) {
    const full = localPath(pkg.packageDir, skill);
    if (full === output || inside(output, full)) invalidPaths();
    if (!stat(full)?.isFile()) mismatch(skill);
  }
  const entry = digest(pkg.packageDir, pkg.entry);
  const files = Object.fromEntries(
    inventory(pkg.packageDir, ['./package.json', ...pkg.files, ...skills], output).map((path) => [
      path,
      digest(pkg.packageDir, path),
    ]),
  );
  const lock = lockfile(pkg.packageDir);
  const integrity = { entry, files, lockfile: hash(readFileSync(lock)) };
  const artifacts: Record<string, string> = {
    [`${pkg.out}/manifest.json`]: serialize({ ...manifest, integrity }),
  };
  for (const [path, schema] of Object.entries(schemas)) {
    const canonical = packagePath(path);
    if (!canonical.startsWith('./schemas/')) invalidPaths();
    const destination = `${pkg.out}/${canonical.slice(2)}`;
    if (Object.hasOwn(artifacts, destination)) invalidPaths();
    artifacts[destination] = serialize(schema);
  }
  return {
    packageDir: pkg.packageDir,
    entry: pkg.entry,
    out: pkg.out,
    lock,
    files,
    artifacts,
    integrity,
  };
}

function guarded(operation: () => void): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof ManifestBuildError) throw error;
    throw new ManifestBuildError('Manifest operation failed.');
  }
}

/** Generate all bytes and validate all paths before removing the validated output directory. */
export function writeManifest<Definition>(options: ManifestOptions<Definition>): void {
  guarded(() => {
    const build = prepare(options);
    const output = resolve(build.packageDir, build.out);
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output);
    for (const [path, bytes] of Object.entries(build.artifacts)) {
      const destination = resolve(build.packageDir, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
  });
}

/** Recompute the inventory, schemas and exact JSON bytes without writing anything. */
export function verifyManifest<Definition>(options: ManifestOptions<Definition>): void {
  guarded(() => {
    const build = prepare(options);
    const manifestPath = `${build.out}/manifest.json`;
    let stored: Record<string, unknown>;
    let storedFiles: Record<string, unknown>;
    try {
      const saved = record(
        JSON.parse(readFileSync(localPath(build.packageDir, manifestPath), 'utf8')),
      );
      stored = record(saved['integrity']);
      storedFiles = record(stored['files']);
    } catch {
      mismatch(manifestPath);
    }
    for (const path of [
      ...new Set([...Object.keys(storedFiles), ...Object.keys(build.files)]),
    ].sort()) {
      try {
        if (packagePath(path) !== path) mismatch(manifestPath);
      } catch {
        mismatch(manifestPath);
      }
      if (storedFiles[path] !== build.files[path]) mismatch(path);
    }
    if (stored['entry'] !== build.integrity.entry) mismatch(build.entry);
    if (stored['lockfile'] !== build.integrity.lockfile) mismatch(build.lock);
    const actual = inventory(build.packageDir, [build.out]);
    for (const path of [...new Set([...actual, ...Object.keys(build.artifacts)])].sort()) {
      if (
        !Object.hasOwn(build.artifacts, path) ||
        !stat(localPath(build.packageDir, path))?.isFile() ||
        readFileSync(localPath(build.packageDir, path), 'utf8') !== build.artifacts[path]
      )
        mismatch(path);
    }
  });
}

if (import.meta.main) {
  try {
    const [packageDir, mode, ...extra] = process.argv.slice(2);
    if (
      packageDir === undefined ||
      (mode !== undefined && mode !== '--verify') ||
      extra.length !== 0
    )
      throw new ManifestBuildError('Usage: node scripts/build-manifest.ts <packageDir> [--verify]');
    const pkg = metadata(packageDir);
    const corePath = createRequire(join(pkg.packageDir, 'package.json')).resolve('@galaxie/core');
    const core = (await import(pathToFileURL(corePath).href)) as {
      createManifest: ManifestOptions<unknown>['createManifest'];
    };
    const module = (await import(
      pathToFileURL(localPath(pkg.packageDir, pkg.entry)).href
    )) as Record<string, unknown>;
    const options = {
      packageDir,
      definition: module[pkg.exportName],
      createManifest: core.createManifest,
    };
    if (mode === '--verify') verifyManifest(options);
    else writeManifest(options);
  } catch (error) {
    console.error(
      error instanceof ManifestBuildError ? error.message : 'Manifest operation failed.',
    );
    process.exitCode = 1;
  }
}
