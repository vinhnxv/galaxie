// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canary } from './host.js';
import { scanBundle } from './request-scan.js';
import { readEnv } from './secrets.js';

export interface EvaluationResult {
  mlflowVersion: string;
  expectedTraces: number;
  traceIds: string[];
  rootIO: { traceId: string; requestPresent: boolean; responsePresent: boolean }[];
  evaluateRows: number;
  rows: {
    traceId: string;
    scores: {
      chat_usage_total: number | null;
      chat_text_present: boolean | null;
      root_io_present: boolean | null;
    };
  }[];
  nonNullCounts: { chat_usage_total: number; chat_text_present: number; root_io_present: number };
}

export async function evaluateSessions(
  sessions: readonly string[],
  expectedTraces: number,
): Promise<EvaluationResult> {
  const settings = readEnv();
  const port = settings['MLFLOW_PORT'];
  if (!/^\d{4,5}$/.test(port ?? '') || Number(port) > 65535)
    throw new Error('Invalid local MLflow port');
  const environment: Record<string, string> = {
    MLFLOW_DISABLE_TELEMETRY: 'true',
    DO_NOT_TRACK: '1',
    MLFLOW_DISABLE_AGENT_HINT: '1',
  };
  for (const name of ['PATH', 'HOME', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const inspect = (stdout: string, stderr: string): void => {
    if (
      scanBundle([stdout, stderr], settings).length > 0 ||
      stdout.includes(canary) ||
      stderr.includes(canary)
    )
      throw new Error('Evaluation output contains a generated credential');
  };
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await promisify(execFile)(
      'uv',
      [
        'run',
        '--locked',
        '--offline',
        'python',
        '-I',
        'evaluate.py',
        '--tracking-uri',
        `http://127.0.0.1:${port}`,
        '--experiment-id',
        settings['MLFLOW_EXPERIMENT_ID'] ?? '',
        '--expected-traces',
        String(expectedTraces),
        ...sessions.flatMap((session) => ['--session', session]),
      ],
      {
        cwd: fileURLToPath(new URL('../python/', import.meta.url)),
        env: environment,
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ));
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: string | number };
    inspect(failure.stdout ?? '', failure.stderr ?? '');
    throw new Error(
      `MLflow evaluation failed (${failure.code ?? 'unknown'}):\n${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    );
  }
  inspect(stdout, stderr);
  const lines = stdout.trim().split('\n');
  if (lines.length !== 1) throw new Error('Evaluation must print exactly one JSON line');
  try {
    return JSON.parse(lines[0] ?? '') as EvaluationResult;
  } catch {
    throw new Error('Evaluation did not print a JSON result');
  }
}
