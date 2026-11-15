// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Layer } from './layers.js';
import { isObject, type JsonObject, mergeFragments } from './merge.js';
import { knownPackages, type PackageManager, TarballError, type Tarballs } from './packages.js';
import { validateOutputPath, validateProjectName } from './paths.js';

export interface ProjectFile {
  readonly bytes: Uint8Array;
  readonly mode: number;
}
export interface ComposeOptions {
  readonly kind: string;
  readonly framework: string;
  readonly name: string;
  readonly mode: 'project' | 'workspace-test';
  readonly packageManager: PackageManager;
  readonly tarballs?: Tarballs;
  readonly workspaceRoot?: string;
}
export interface ComposeReport {
  readonly layers: readonly string[];
  readonly filesByLayer: Readonly<Record<string, readonly string[]>>;
}
export interface Composition {
  readonly files: Map<string, ProjectFile>;
  readonly report: ComposeReport;
}
export class LayerCollisionError extends Error {
  constructor(path: string, first: string, second: string) {
    super(`Layer collision at ${path} between layers ${first} and ${second}.`);
  }
}
export class SelectionError extends Error {}

const jsonBytes = (value: JsonObject): Uint8Array =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const packageOrder = [
  'name',
  'version',
  'private',
  'description',
  'license',
  'type',
  'engines',
  'scripts',
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'overrides',
];
function orderedPackage(value: JsonObject): JsonObject {
  const ordered: JsonObject = {};
  for (const key of [
    ...packageOrder,
    ...Object.keys(value)
      .filter((key) => !packageOrder.includes(key))
      .sort(),
  ]) {
    if (!Object.hasOwn(value, key)) continue;
    const field = value[key];
    ordered[key] =
      isObject(field) &&
      [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
        'overrides',
      ].includes(key)
        ? Object.fromEntries(
            Object.entries(field).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            ),
          )
        : (field as NonNullable<typeof field>);
  }
  return ordered;
}

export function compose(layers: readonly Layer[], options: ComposeOptions): Composition {
  validateProjectName(options.name);
  const kinds = layers.filter((layer) => layer.manifest.type === 'kind');
  const frameworks = layers.filter((layer) => layer.manifest.type === 'framework');
  const kind = kinds.find((layer) => layer.manifest.id === options.kind);
  const framework = frameworks.find((layer) => layer.manifest.id === options.framework);
  if (kind === undefined)
    throw new SelectionError(
      `Unknown kind. Valid kinds: ${kinds
        .map((layer) => layer.manifest.id)
        .sort()
        .join(', ')}.`,
    );
  if (framework === undefined || !kind.manifest.frameworks?.includes(options.framework))
    throw new SelectionError(
      `Unsupported framework for this kind. Valid frameworks: ${kind.manifest.frameworks?.join(', ') ?? ''}.`,
    );
  const bases = layers.filter((layer) => layer.manifest.type === 'base');
  if (bases.length !== 1) throw new SelectionError('Expected one base layer. Valid base: base.');
  const selected = [bases[0] as Layer, kind, framework];
  const files = new Map<string, ProjectFile>();
  const owners = new Map<string, string>();
  const filesByLayer: Record<string, string[]> = {};
  const add = (raw: string, bytes: Uint8Array, owner: string): void => {
    validateOutputPath(raw);
    const path = raw
      .split('/')
      .map((part) => (part === '_gitignore' ? '.gitignore' : part))
      .join('/');
    validateOutputPath(path);
    for (const [existing, previous] of owners)
      if (existing === path || existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`))
        throw new LayerCollisionError(path, previous, owner);
    if (Buffer.from(bytes).includes(Buffer.from('\r\n')))
      throw new SelectionError('Layer files must use LF line endings.');
    files.set(path, { bytes: Uint8Array.from(bytes), mode: 0o644 });
    owners.set(path, owner);
    filesByLayer[owner] ??= [];
    filesByLayer[owner].push(path);
  };
  for (const layer of selected) {
    for (const [path, bytes] of layer.files) add(path, bytes, layer.manifest.id);
    if (options.mode === 'workspace-test')
      for (const [path, bytes] of layer.workspaceFiles) add(path, bytes, layer.manifest.id);
  }
  const patches = new Map<string, Array<{ layer: string; value: JsonObject }>>();
  for (const layer of selected)
    for (const [path, value] of Object.entries(layer.manifest.json ?? {})) {
      validateOutputPath(path);
      const emitted = files.get(path);
      if (emitted === undefined || !path.endsWith('.json') || path === 'package.json')
        throw new SelectionError(
          'JSON patches require an existing JSON output path outside package.json.',
        );
      let fragments = patches.get(path);
      if (fragments === undefined) {
        let original: unknown;
        try {
          original = JSON.parse(Buffer.from(emitted.bytes).toString('utf8'));
        } catch {
          throw new SelectionError('The JSON output seed must be an object.');
        }
        if (!isObject(original))
          throw new SelectionError('The JSON output seed must be an object.');
        fragments = [{ layer: owners.get(path) as string, value: original }];
        patches.set(path, fragments);
      }
      fragments.push({ layer: layer.manifest.id, value });
    }
  for (const [path, fragments] of patches)
    files.set(path, { bytes: jsonBytes(mergeFragments(fragments, path)), mode: 0o644 });
  const manifest = mergeFragments(
    selected.map((layer) => ({ layer: layer.manifest.id, value: layer.manifest.package })),
  );
  manifest['name'] = options.name;
  if (options.tarballs !== undefined) {
    if (options.packageManager !== 'npm')
      throw new TarballError(
        'Tarball mode supports npm only; pnpm and yarn tarball installs are not proven.',
      );
    const overrides: JsonObject = {};
    for (const name of knownPackages) {
      const path = options.tarballs.get(name);
      if (path === undefined || !isAbsolute(path))
        throw new TarballError(`Expected an absolute tarball path for ${name}.`);
      overrides[name] = `file:${path}`;
    }
    for (const section of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      const dependencies = manifest[section];
      if (!isObject(dependencies)) continue;
      for (const name of Object.keys(dependencies))
        if (name.startsWith('@galaxie-ai/')) {
          if (!Object.hasOwn(overrides, name))
            throw new TarballError('The layer names an unknown galaxie package.');
          dependencies[name] = overrides[name] as string;
        }
    }
    manifest['overrides'] = mergeFragments(
      [
        { layer: 'layers', value: isObject(manifest['overrides']) ? manifest['overrides'] : {} },
        { layer: 'tarballs', value: overrides },
      ],
      'package.json.overrides',
    );
  }
  add('package.json', jsonBytes(orderedPackage(manifest)), 'composer');
  if (options.mode === 'workspace-test') {
    if (options.workspaceRoot === undefined || !isAbsolute(options.workspaceRoot))
      throw new SelectionError('Workspace-test mode requires an absolute workspace root.');
    const workspace = mergeFragments(
      selected.map((layer) => ({
        layer: layer.manifest.id,
        value: (layer.manifest.workspace ?? {}) as JsonObject,
      })),
      'tsconfig.workspace.json',
    );
    const paths = workspace['paths'];
    const outputRoot = resolve(
      options.workspaceRoot,
      'packages/create/.cache/composed',
      `${options.kind}-${options.framework}`,
    );
    const mapped: JsonObject = {};
    if (isObject(paths))
      for (const [name, entries] of Object.entries(paths)) {
        mapped[name] = (entries as string[]).map((entry) =>
          relative(outputRoot, resolve(options.workspaceRoot as string, validateOutputPath(entry)))
            .split(sep)
            .join('/'),
        );
      }
    add(
      'tsconfig.workspace.json',
      jsonBytes({
        extends: './tsconfig.json',
        compilerOptions: { paths: mapped },
        include: workspace['include'] ?? ['src', 'vite.config.ts'],
      }),
      'composer',
    );
  }
  for (const paths of Object.values(filesByLayer)) paths.sort();
  return {
    files: new Map(
      [...files].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
    report: { layers: selected.map((layer) => layer.manifest.id), filesByLayer },
  };
}
