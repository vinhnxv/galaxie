// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (spawnSync('uv', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error('Python tests require uv; install uv and sync the pinned Python environment.');
  process.exitCode = 1;
} else {
  const result = spawnSync(
    'uv',
    ['run', '--locked', '--offline', 'python', '-I', '-m', 'pytest', ...process.argv.slice(2)],
    {
      cwd: fileURLToPath(new URL('../python/', import.meta.url)),
      stdio: 'inherit',
      env: {
        ...process.env,
        PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1',
        LANGSMITH_TRACING: 'false',
        LANGCHAIN_TRACING_V2: 'false',
      },
    },
  );
  process.exitCode = result.status ?? 1;
}
