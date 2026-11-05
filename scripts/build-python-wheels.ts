// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../.cache/python-wheels/', import.meta.url));
await mkdir(directory, { recursive: true });
// Build without isolation inside the synced, locked environment, which provides setuptools.
const interpreter = fileURLToPath(
  new URL(
    process.platform === 'win32'
      ? '../python/.venv/Scripts/python.exe'
      : '../python/.venv/bin/python',
    import.meta.url,
  ),
);
const packages = [];
for (const [name, version] of [
  ['galaxie', '0.0.0'],
  ['ormsgpack', '1.13.0'],
] as const) {
  const result = spawnSync(
    'uv',
    [
      'build',
      '--project',
      'python',
      '--package',
      name,
      '--wheel',
      '--offline',
      '--no-build-isolation',
      '--python',
      interpreter,
      '--out-dir',
      directory,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0)
    throw new Error(
      'Python wheels could not be built; install uv and sync the pinned Python environment.',
    );
  const file = `${name}-${version}-py3-none-any.whl`;
  const bytes = await readFile(new URL(file, new URL('../.cache/python-wheels/', import.meta.url)));
  packages.push({
    name,
    version,
    file,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
await writeFile(
  new URL('../.cache/python-wheels/local-wheels.json', import.meta.url),
  `${JSON.stringify({ v: 'galaxie.python-build/v1', packages }, null, 2)}\n`,
);
