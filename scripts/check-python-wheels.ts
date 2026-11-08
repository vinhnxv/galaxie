// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Fails when the local galaxie wheel is older than the galaxie Python source it was built from.
// The Pyodide tests load that wheel from the git-ignored cache, so a stale wheel makes them fail
// with a generic executor error that does not name the cause. CI rebuilds the wheel in its setup
// step, so this only matters on a machine that built it earlier.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const wheel = join(root, '.cache', 'python-wheels', 'galaxie-0.0.0-py3-none-any.whl');

// Without a wheel the Pyodide tests skip and say why, so there is nothing stale to report.
if (!existsSync(wheel)) {
  console.log('No local galaxie wheel found; the Pyodide tests will skip.');
} else {
  const sources: string[] = [];
  const collect = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else sources.push(path);
    }
  };
  collect(join(root, 'python', 'galaxie', 'src'));
  sources.push(join(root, 'python', 'galaxie', 'pyproject.toml'));

  const built = statSync(wheel).mtimeMs;
  const newer = sources.filter((path) => statSync(path).mtimeMs > built);
  if (newer.length > 0) {
    console.error('The local galaxie wheel is older than its Python source:');
    for (const path of newer) console.error(`  ${path.slice(root.length)}`);
    console.error('Rebuild it with: node scripts/build-python-wheels.ts');
    process.exitCode = 1;
  }
}
