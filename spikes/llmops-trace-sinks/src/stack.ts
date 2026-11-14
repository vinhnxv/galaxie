// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ensureEnv, envPath, readEnv, redact, setExperimentId } from './secrets.js';

const cwd = fileURLToPath(new URL('../', import.meta.url));

function compose(args: string[]): string {
  const environmentFile = existsSync(envPath)
    ? envPath
    : new URL('../.env.example', import.meta.url);
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('COMPOSE_')),
  );
  try {
    return execFileSync(
      'docker',
      [
        'compose',
        '--project-name',
        'galaxie-llmops-trace-sinks',
        '--file',
        fileURLToPath(new URL('../compose.yaml', import.meta.url)),
        '--env-file',
        fileURLToPath(environmentFile),
        ...args,
      ],
      {
        cwd,
        env: { ...childEnv, ...readEnv(environmentFile) },
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 20 * 1024 * 1024,
      },
    );
  } catch (error) {
    const failure = error as Error & { stderr?: Buffer; stdout?: Buffer };
    throw new Error(redact(`${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`));
  }
}

async function freePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', () =>
      reject(new Error(`Host port ${port} is occupied; stop its owner before stack:up`)),
    );
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}

async function waitHttp(url: string, timeout = 240_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      await response.body?.cancel().catch(() => {});
      if (response.ok) return;
    } catch {}
    await setTimeout(1000);
  }
  throw new Error(`Health timeout at ${url}`);
}

async function main(): Promise<void> {
  if (process.argv[2] === 'down') {
    console.log(redact(compose(['down', '-v', '--remove-orphans'])));
    if (existsSync(envPath)) setExperimentId('');
    return;
  }
  if (process.argv[2] !== 'up') throw new Error('Usage: pnpm run stack:up|stack:down');
  const env = ensureEnv();
  if (
    env['LANGFUSE_OTEL_ENDPOINT'] !== 'http://langfuse-web:3000/api/public/otel' ||
    env['MLFLOW_OTEL_ENDPOINT'] !== 'http://mlflow:5100'
  )
    throw new Error('Collector endpoints must remain on the local compose network');
  const mlflowPort = Number(env['MLFLOW_PORT']);
  if (!Number.isInteger(mlflowPort) || mlflowPort < 1024 || mlflowPort > 65535)
    throw new Error('Invalid MLFLOW_PORT');
  for (const port of [3000, mlflowPort, 4318]) await freePort(port);
  console.log('Starting local backends; waiting for container health (up to 240 seconds).');
  console.log(
    redact(
      compose([
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        '240',
        'langfuse-web',
        'langfuse-worker',
        'mlflow',
      ]),
    ),
  );
  await waitHttp(`http://127.0.0.1:${mlflowPort}/health`);
  await waitHttp('http://127.0.0.1:3000/api/public/health');
  const base = `http://127.0.0.1:${mlflowPort}/api/2.0/mlflow/experiments`;
  const lookup = await fetch(`${base}/get-by-name?experiment_name=galaxie-smoke`, {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  let id: string;
  if (lookup.ok) {
    id = ((await lookup.json()) as { experiment: { experiment_id: string } }).experiment
      .experiment_id;
  } else {
    const body = (await lookup.json()) as { error_code?: string };
    if (body.error_code !== 'RESOURCE_DOES_NOT_EXIST')
      throw new Error(`Experiment lookup failed: HTTP ${lookup.status}`);
    const response = await fetch(`${base}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'galaxie-smoke' }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Experiment creation failed: HTTP ${response.status}`);
    id = ((await response.json()) as { experiment_id: string }).experiment_id;
  }
  setExperimentId(id);
  console.log(redact(compose(['up', '-d', '--force-recreate', 'collector'])));
  // OTLP/HTTP returns 405 to GET when its receiver has started.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:4318/v1/traces', {
        signal: AbortSignal.timeout(1000),
        redirect: 'error',
      });
      await response.body?.cancel().catch(() => {});
      if (response.status === 405) {
        console.log(
          'Backends and collector are ready. Credentials stay in the mode-0600 .env file.',
        );
        return;
      }
    } catch {}
    await setTimeout(500);
  }
  throw new Error('Collector did not become ready within 30 seconds');
}

main().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
