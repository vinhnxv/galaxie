// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import {
  type LockedWheel,
  lockedWheels,
  runtimeFiles,
} from '../../../../packages/adapter-pyodide/src/runtime-files.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const agentDirectory = fileURLToPath(new URL('../../agent_py/', import.meta.url));

/** Uses local assets only. Missing prerequisites omit the entire Python lane. */
export function pythonAssets(cacheDirectory: string = join(root, '.cache/python-wheels')): Plugin {
  const assets: { fileName: string; source: Uint8Array }[] = [];
  let building = false;
  let available = false;
  let localWheels: readonly LockedWheel[] = [];
  return {
    name: 'adk-recipes-python-assets',
    configResolved(config) {
      building = config.command === 'build';
    },
    buildStart() {
      assets.length = 0;
      available = false;
      localWheels = [];
      if (!building) return;
      if (!existsSync(agentDirectory) || !existsSync(join(cacheDirectory, 'local-wheels.json')))
        return;
      const sources = readdirSync(agentDirectory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.py'))
        .map((entry) => join(entry.parentPath, entry.name))
        .filter((file) => !relative(agentDirectory, file).split(sep).includes('tests'));
      if (sources.length === 0) return;
      const local = (
        JSON.parse(readFileSync(join(cacheDirectory, 'local-wheels.json'), 'utf8')) as {
          packages: LockedWheel[];
        }
      ).packages.filter(
        (wheel) => wheel.frameworks === undefined || wheel.frameworks.includes('adk'),
      );
      const wheels = [
        ...lockedWheels.filter((wheel) => wheel.frameworks?.includes('adk')),
        ...local,
      ];
      if (local.length === 0) return;
      const runtimeDirectory = join(root, 'packages/adapter-pyodide/node_modules/pyodide');
      if (
        wheels.some((wheel) => !existsSync(join(cacheDirectory, wheel.file))) ||
        runtimeFiles.some((file) => !existsSync(join(runtimeDirectory, file.file)))
      )
        return;
      for (const wheel of wheels) {
        if (!/^[a-zA-Z0-9_.+-]+\.whl$/.test(wheel.file))
          throw new Error('The Python wheel inventory is invalid.');
        const bytes = readFileSync(join(cacheDirectory, wheel.file));
        if (
          bytes.length !== wheel.bytes ||
          createHash('sha256').update(bytes).digest('hex') !== wheel.sha256
        )
          throw new Error('The Python wheel inventory is invalid.');
        assets.push({ fileName: `python/wheels/${wheel.file}`, source: bytes });
      }
      for (const file of runtimeFiles) {
        const bytes = readFileSync(join(runtimeDirectory, file.file));
        if (bytes.length !== file.bytes)
          throw new Error('The Python runtime inventory is invalid.');
        assets.push({ fileName: `python/runtime/${file.file}`, source: bytes });
      }
      for (const file of sources)
        assets.push({
          fileName: `python/agent/${relative(agentDirectory, file).replaceAll('\\', '/')}`,
          source: readFileSync(file),
        });
      localWheels = local;
      available = true;
    },
    resolveId(id) {
      return id === 'virtual:adk-recipes-python' ? '\0adk-recipes-python' : undefined;
    },
    load(id) {
      if (id !== '\0adk-recipes-python') return undefined;
      return `export const pythonBuild = ${JSON.stringify({ available, localWheels, bytes: assets.reduce((sum, asset) => sum + asset.source.length, 0) })};`;
    },
    generateBundle() {
      for (const asset of assets) this.emitFile({ type: 'asset', ...asset });
    },
  };
}
