// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const launchPackages = [
  'packages/ui-protocol',
  'packages/core',
  'packages/adapter-kit',
  'packages/adapter-langgraph',
  'packages/models',
  'packages/storage-indexeddb',
  'packages/react',
];

interface Dependency {
  readonly name: string;
  readonly version: string;
  readonly launchPackage: string;
  readonly directory: string;
}

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly license?: unknown;
  readonly licenses?: unknown;
}

interface Allowlist {
  readonly permissive: readonly string[];
  readonly exceptions: readonly {
    readonly package: string;
    readonly license: string;
    readonly reason: string;
  }[];
}

interface CheckResult {
  readonly checked: readonly Dependency[];
  readonly failures: readonly string[];
}

function identity(dependency: Dependency): string {
  return `${dependency.name}@${dependency.version} (via ${dependency.launchPackage})`;
}

function licenseText(value: unknown): string {
  if (typeof value === 'string') return value.trim() || 'UNKNOWN';
  if (value !== null && typeof value === 'object' && 'type' in value)
    return licenseText(value.type);
  return JSON.stringify(value) ?? 'UNKNOWN';
}

/** SPDX boolean expressions have AND precedence over OR; unsupported terms stay unknown. */
function allowedExpression(expression: string, permissive: ReadonlySet<string>): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;
  let valid = true;
  const atom = (): boolean => {
    const token = tokens[position++];
    if (token === '(') {
      const allowed = or();
      if (tokens[position++] !== ')') valid = false;
      return allowed;
    }
    if (token === undefined || token === ')' || token === 'AND' || token === 'OR') {
      valid = false;
      return false;
    }
    return token !== 'UNLICENSED' && token !== 'UNKNOWN' && permissive.has(token);
  };
  const and = (): boolean => {
    let allowed = atom();
    while (tokens[position] === 'AND') {
      position++;
      const next = atom();
      allowed = allowed && next;
    }
    return allowed;
  };
  const or = (): boolean => {
    let allowed = and();
    while (tokens[position] === 'OR') {
      position++;
      const next = and();
      allowed = allowed || next;
    }
    return allowed;
  };
  const allowed = or();
  return valid && position === tokens.length && allowed;
}

export function checkDependencyLicenses(
  dependencies: readonly Dependency[],
  readLicense: (dependency: Dependency) => {
    readonly license?: unknown;
    readonly licenses?: unknown;
  },
  allowlist: Allowlist,
): CheckResult {
  for (const exception of allowlist.exceptions) {
    if (typeof exception.reason !== 'string' || exception.reason.trim() === '')
      throw new Error(`${exception.package}: a license exception requires a non-empty reason.`);
    if (typeof exception.license !== 'string' || exception.license.trim() === '')
      throw new Error(`${exception.package}: a license exception requires an accepted license.`);
  }
  const permissive = new Set(allowlist.permissive);
  const failures: string[] = [];
  if (dependencies.length === 0) failures.push('The checked runtime dependency set is empty.');
  for (const dependency of dependencies) {
    try {
      const manifest = readLicense(dependency);
      const licenses =
        manifest.license !== undefined
          ? [manifest.license]
          : Array.isArray(manifest.licenses)
            ? manifest.licenses
            : [];
      const texts = licenses.map(licenseText);
      if (
        !texts.some((text) => allowedExpression(text, permissive)) &&
        !allowlist.exceptions.some(
          (exception) => exception.package === dependency.name && texts.includes(exception.license),
        )
      )
        failures.push(`${identity(dependency)}: ${texts.join(' OR ') || 'UNKNOWN'}`);
    } catch (error) {
      failures.push(`${identity(dependency)}: UNKNOWN; ${String(error)}`);
    }
  }
  return { checked: dependencies, failures };
}

interface LockEntry {
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
  readonly optionalDependencies: Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

interface Lockfile {
  readonly importers: Record<string, LockEntry>;
  readonly packages: Record<string, LockEntry>;
  readonly snapshots: Record<string, LockEntry>;
}

function scalar(value: string): string {
  if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.startsWith('"')) return JSON.parse(value) as string;
  return value;
}

/** Reads only pnpm v9's importer pins, snapshot edges and inline platform lists. */
function parseLockfile(text: string): Lockfile {
  if (!/^lockfileVersion: ['"]?9\.0['"]?\r?$/m.test(text))
    throw new Error('Expected pnpm lockfile version 9.0.');
  const lock: Lockfile = { importers: {}, packages: {}, snapshots: {} };
  let section: Record<string, LockEntry> | undefined;
  let entry: LockEntry | undefined;
  let group = '';
  let dependency = '';
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      section =
        line === 'importers:'
          ? lock.importers
          : line === 'packages:'
            ? lock.packages
            : line === 'snapshots:'
              ? lock.snapshots
              : undefined;
      entry = undefined;
    }
    if (section === undefined) continue;
    const record = /^  (\S.*?):(?: \{\})?$/.exec(line);
    if (record?.[1] !== undefined) {
      entry = { dependencies: {}, devDependencies: {}, optionalDependencies: {} };
      section[scalar(record[1])] = entry;
      group = '';
      continue;
    }
    if (entry === undefined) continue;
    const field = /^    (\w+):(?: (.*))?$/.exec(line);
    if (field?.[1] !== undefined) {
      group = field[1];
      if (group === 'os' || group === 'cpu' || group === 'libc') {
        const values = field[2];
        if (values === undefined || !/^\[.*\]$/.test(values))
          throw new Error(`Expected an inline ${group} list in pnpm-lock.yaml.`);
        entry[group] = values
          .slice(1, -1)
          .split(',')
          .map((value) => scalar(value.trim()));
      }
      continue;
    }
    if (group !== 'dependencies' && group !== 'devDependencies' && group !== 'optionalDependencies')
      continue;
    const edge = /^      (\S.*?):(?: (.+))?$/.exec(line);
    if (edge?.[1] !== undefined) {
      dependency = scalar(edge[1]);
      if (edge[2] !== undefined) entry[group][dependency] = scalar(edge[2]);
    }
    const pin = /^        version: (.+)$/.exec(line);
    if (pin?.[1] !== undefined) entry[group][dependency] = scalar(pin[1]);
  }
  return lock;
}

function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Manifest;
}

let linuxLibc: string | undefined;

function hostLibc(): string {
  if (process.platform !== 'linux') return '';
  if (linuxLibc === undefined) {
    // The diagnostic report is costly to build, and the answer cannot change within one run.
    const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
    linuxLibc = report.header.glibcVersionRuntime ? 'glibc' : 'musl';
  }
  return linuxLibc;
}

function platformExcluded(entry: LockEntry): boolean {
  const libc = hostLibc();
  const matches = (values: readonly string[] | undefined, actual: string): boolean =>
    values === undefined ||
    (!values.includes(`!${actual}`) &&
      (values.every((value) => value.startsWith('!')) ||
        values.includes(actual) ||
        values.includes('any')));
  return (
    !matches(entry.os, process.platform) ||
    !matches(entry.cpu, process.arch) ||
    !matches(entry.libc, libc)
  );
}

function main(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const lock = parseLockfile(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  const allowlist = JSON.parse(
    readFileSync(new URL('./dependency-license-allowlist.json', import.meta.url), 'utf8'),
  ) as Allowlist;
  const dependencies: Dependency[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];
  const visited = new Set<string>();

  const visit = (name: string, reference: string, modules: string, launchPackage: string): void => {
    const key = `${name}@${reference}`;
    const dependency: Dependency = {
      name,
      version: reference.split('(')[0] ?? reference,
      directory: join(modules, name),
      launchPackage,
    };
    const visitKey = `${launchPackage}:${key}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    const snapshot = lock.snapshots[key];
    const metadata = lock.packages[`${name}@${dependency.version}`];
    if (snapshot === undefined || metadata === undefined) {
      failures.push(`${identity(dependency)}: UNKNOWN; missing lockfile package or snapshot.`);
      return;
    }
    let directory: string;
    try {
      directory = realpathSync(dependency.directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === 'ENOENT' || code === 'ENOTDIR') && platformExcluded(metadata))
        skipped.push(`${identity(dependency)}: not installed on this platform`);
      else dependencies.push(dependency);
      return;
    }
    dependencies.push(dependency);
    // Resolve dependencies beside the real package, including scoped packages and hashed stores.
    const siblings = name.startsWith('@') ? dirname(dirname(directory)) : dirname(directory);
    for (const [child, version] of Object.entries({
      ...snapshot.dependencies,
      ...snapshot.optionalDependencies,
    }))
      visit(child, version, siblings, launchPackage);
  };

  const importer = (directory: string, launchPackage: string): void => {
    const path = relative(root, directory).replaceAll('\\', '/');
    const visitKey = `${launchPackage}:workspace:${path}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    const manifest = readManifest(directory);
    const pins = lock.importers[path];
    if (pins === undefined) throw new Error(`${manifest.name}: missing lockfile importer ${path}.`);
    for (const [name, specifier] of Object.entries({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    })) {
      const reference =
        pins.dependencies[name] ?? pins.optionalDependencies[name] ?? pins.devDependencies[name];
      if (reference === undefined) {
        failures.push(`${name}@UNKNOWN (via ${launchPackage}): UNKNOWN; missing importer pin.`);
      } else if (reference.startsWith('link:')) {
        importer(resolve(directory, reference.slice(5)), launchPackage);
      } else if (specifier.startsWith('workspace:')) {
        failures.push(
          `${name}@${reference} (via ${launchPackage}): UNKNOWN; missing workspace link.`,
        );
      } else {
        visit(name, reference, join(directory, 'node_modules'), launchPackage);
      }
    }
  };

  for (const path of launchPackages) {
    const directory = join(root, path);
    importer(directory, readManifest(directory).name);
  }
  const result = checkDependencyLicenses(
    dependencies,
    (dependency) => {
      const manifest = readManifest(dependency.directory);
      if (manifest.version !== dependency.version)
        throw new Error(`Installed version ${manifest.version} does not match the lockfile.`);
      return manifest;
    },
    allowlist,
  );
  failures.push(...result.failures);
  console.log(`Checked ${result.checked.length} locked runtime dependencies.`);
  console.log(
    [...new Set(result.checked.map(({ name, version }) => `${name}@${version}`))].sort().join(', '),
  );
  if (skipped.length > 0) console.log(skipped.join('\n'));
  if (failures.length > 0) {
    console.error(`Dependency license check failed:\n${failures.join('\n')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Dependency license check failed: ${String(error)}`);
    process.exitCode = 1;
  }
}
