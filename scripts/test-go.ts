// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../go/', import.meta.url));
const commands: ReadonlyArray<{ args: string[]; env: NodeJS.ProcessEnv }> = [
  { args: ['vet', './...'], env: {} },
  { args: ['vet', './...'], env: { GOOS: 'js', GOARCH: 'wasm' } },
  { args: ['test', './...'], env: {} },
  { args: ['test', '-race', './...'], env: { CGO_ENABLED: '1' } },
  { args: ['mod', 'verify'], env: {} },
];

if (spawnSync('go', ['version'], { stdio: 'ignore' }).status !== 0) {
  console.error('Go tests require the Go toolchain; install Go 1.27.3 (see go/go.mod).');
  process.exitCode = 1;
} else {
  for (const { args, env } of commands) {
    const result = spawnSync('go', args, {
      cwd: directory,
      stdio: 'inherit',
      env: { ...process.env, GOTOOLCHAIN: 'local', CGO_ENABLED: '0', ...env },
    });
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}
