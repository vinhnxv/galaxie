// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isJson, isObject, type JsonObject } from './merge.js';
import { validateOutputPath } from './paths.js';

export interface WorkspaceFragment {
  paths?: Record<string, string[]>;
  include?: string[];
}
export interface LayerManifest {
  schema: 1;
  id: string;
  type: 'base' | 'kind' | 'framework';
  package: JsonObject;
  json?: Record<string, JsonObject>;
  frameworks?: string[];
  workspace?: WorkspaceFragment;
}
export interface Layer {
  manifest: LayerManifest;
  files: ReadonlyMap<string, Uint8Array>;
  workspaceFiles: ReadonlyMap<string, Uint8Array>;
}
export class LayerManifestError extends Error {}

function invalid(reason: string): never {
  throw new LayerManifestError(
    `Invalid layer manifest: ${reason}. Valid schema: 1; valid types: base, kind, framework; valid keys: schema, id, type, package, json, frameworks, workspace.`,
  );
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function validateManifest(value: unknown, id: string, type: LayerManifest['type']): LayerManifest {
  if (!isObject(value) || !isJson(value)) invalid('expected a JSON object');
  const allowed = ['schema', 'id', 'type', 'package', 'json', 'frameworks', 'workspace'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid('unknown key');
  if (value['schema'] !== 1) invalid('unsupported schema');
  if (value['id'] !== id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    invalid('id must match the layer directory');
  if (value['type'] !== type) invalid('type must match the layer directory');
  if (!isObject(value['package'])) invalid('package must be an object');
  const frameworks = value['frameworks'];
  if (
    (type === 'kind' && (!strings(frameworks) || frameworks.length === 0)) ||
    (type !== 'kind' && frameworks !== undefined)
  )
    invalid('frameworks belongs to kind layers and must list supported framework ids');
  if (
    frameworks !== undefined &&
    (!strings(frameworks) || frameworks.some((item) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item)))
  )
    invalid('frameworks must list supported framework ids');
  const patches = value['json'];
  if (patches !== undefined) {
    if (!isObject(patches)) invalid('json must be an object');
    for (const [path, patch] of Object.entries(patches)) {
      try {
        validateOutputPath(path);
      } catch {
        invalid('json target path is invalid');
      }
      if (!path.endsWith('.json') || path === 'package.json' || !isObject(patch))
        invalid('json targets must be JSON objects outside package.json');
    }
  }
  const workspace = value['workspace'];
  if (workspace !== undefined) {
    if (
      !isObject(workspace) ||
      Object.keys(workspace).some((key) => !['paths', 'include'].includes(key))
    )
      invalid('workspace permits paths and include');
    if (workspace['include'] !== undefined && !strings(workspace['include']))
      invalid('workspace include must be strings');
    if (workspace['paths'] !== undefined) {
      if (!isObject(workspace['paths'])) invalid('workspace paths must be an object');
      for (const entries of Object.values(workspace['paths'])) {
        if (!strings(entries) || entries.length === 0)
          invalid('workspace paths must have string arrays');
        for (const path of entries) {
          try {
            validateOutputPath(path);
          } catch {
            invalid('workspace source path is invalid');
          }
        }
      }
    }
  }
  return value as unknown as LayerManifest;
}
async function readTree(directory: string): Promise<Map<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  const visit = async (full: string, prefix: string): Promise<void> => {
    const info = await lstat(full).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && prefix === '') return undefined;
      throw error;
    });
    if (info === undefined) return;
    if (info.isSymbolicLink()) throw new LayerManifestError('Layer symlinks are not supported.');
    if (!info.isDirectory()) throw new LayerManifestError('A layer file tree must be a directory.');
    for (const entry of (await readdir(full)).sort()) {
      const path = prefix === '' ? entry : `${prefix}/${entry}`;
      validateOutputPath(path);
      const child = join(full, entry);
      const stat = await lstat(child);
      if (stat.isSymbolicLink()) throw new LayerManifestError('Layer symlinks are not supported.');
      if (stat.isDirectory()) await visit(child, path);
      else if (stat.isFile()) {
        const bytes = await readFile(child);
        if (bytes.includes(Buffer.from('\r\n')))
          throw new LayerManifestError('Layer files must use LF line endings.');
        result.set(path, bytes);
      } else throw new LayerManifestError('Layer entries must be regular files or directories.');
    }
  };
  await visit(directory, '');
  return result;
}

export async function loadLayers(templatesRoot: string): Promise<Layer[]> {
  const layers: Layer[] = [];
  const load = async (
    directory: string,
    id: string,
    type: LayerManifest['type'],
  ): Promise<void> => {
    if ((await lstat(directory)).isSymbolicLink())
      throw new LayerManifestError('Layer symlinks are not supported.');
    const manifestPath = join(directory, 'layer.json');
    if (!(await lstat(manifestPath)).isFile() || (await lstat(manifestPath)).isSymbolicLink())
      throw new LayerManifestError('The layer manifest must be a regular file.');
    const bytes = await readFile(manifestPath, 'utf8');
    if (bytes.includes('\r\n'))
      throw new LayerManifestError('Layer files must use LF line endings.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes);
    } catch {
      invalid('expected JSON');
    }
    layers.push({
      manifest: validateManifest(parsed, id, type),
      files: await readTree(join(directory, 'files')),
      workspaceFiles: await readTree(join(directory, 'workspace')),
    });
  };
  await load(join(templatesRoot, 'base'), 'base', 'base');
  for (const [group, type] of [
    ['kinds', 'kind'],
    ['frameworks', 'framework'],
  ] as const) {
    const directory = join(templatesRoot, group);
    if ((await lstat(directory)).isSymbolicLink())
      throw new LayerManifestError('Layer symlinks are not supported.');
    for (const id of (await readdir(directory)).sort()) await load(join(directory, id), id, type);
  }
  return layers;
}
