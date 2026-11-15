// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose } from './compose.js';
import { loadLayers } from './layers.js';
import { planWrite, writeProject } from './write.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
let cache = join(repo, 'packages/create');
for (const part of ['.cache', 'composed']) {
  cache = join(cache, part);
  const info = await lstat(cache).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (info?.isSymbolicLink() || (info !== undefined && !info.isDirectory()))
    throw new Error('The composed cache must use real directories.');
  if (info === undefined) await mkdir(cache, { mode: 0o755 });
}
const layers = await loadLayers(join(repo, 'templates'));
for (const kind of ['browser-only', 'gateway']) {
  const name = `${kind}-langgraph-js`;
  const { files } = compose(layers, {
    kind,
    framework: 'langgraph-js',
    name,
    mode: 'workspace-test',
    packageManager: 'npm',
    workspaceRoot: repo,
  });
  const directory = join(cache, name);
  await rm(directory, { recursive: true, force: true });
  await writeProject(await planWrite(files, directory));
}
