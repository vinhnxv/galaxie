// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const appRoot = fileURLToPath(new URL('../', import.meta.url));
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');

export function gitStatus(): string {
  const result = spawnSync('git', ['status', '--short', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

interface NextProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<[number | null, NodeJS.Signals | null]>;
  output(): string;
}

function launch(args: string[], distDir: string): NextProcess {
  const child = spawn(process.execPath, [nextBin, ...args], {
    cwd: appRoot,
    env: {
      ...process.env,
      NODE_ENV: args[0] === 'dev' ? 'development' : 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      GALAXIE_NEXT_DIST_DIR: distDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  return { child, exited, output: () => output };
}

async function stop(process: NextProcess): Promise<void> {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill('SIGTERM');
  const timer = setTimeout(() => process.child.kill('SIGKILL'), 5000);
  try {
    await process.exited;
  } finally {
    clearTimeout(timer);
  }
}

export async function build(distDir: string): Promise<void> {
  const process = launch(['build', '--webpack'], distDir);
  const timer = setTimeout(() => process.child.kill('SIGKILL'), 280_000);
  try {
    const [code] = await process.exited;
    if (code !== 0) throw new Error(`next build --webpack failed (${code}):\n${process.output()}`);
  } finally {
    clearTimeout(timer);
    await stop(process);
  }
}

export interface NextServer {
  readonly origin: string;
  stop(): Promise<void>;
}

export async function serve(mode: 'start' | 'dev', distDir: string): Promise<NextServer> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('No free port.');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const process = launch([mode, '--hostname', '127.0.0.1', '--port', String(port)], distDir);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (process.child.exitCode !== null || process.child.signalCode !== null)
        throw new Error(`next ${mode} exited:\n${process.output()}`);
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(2000) });
        if (response.ok) return { origin, stop: () => stop(process) };
      } catch {
        /* The server has not started listening yet. */
      }
      await delay(100);
    }
    throw new Error(`next ${mode} did not start:\n${process.output()}`);
  } catch (error) {
    await stop(process);
    throw error;
  }
}
