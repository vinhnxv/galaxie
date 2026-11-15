// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { evaluateSessions } from '../src/evaluate.js';

vi.mock('../src/secrets.js', () => ({
  readEnv: () => ({
    MLFLOW_PORT: '5100',
    MLFLOW_EXPERIMENT_ID: '1',
    LANGFUSE_INIT_PROJECT_SECRET_KEY: 'synthetic-private-evaluation-secret',
  }),
}));

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function stubUv(program: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'galaxie-evaluation-'));
  directories.push(directory);
  const executable = join(directory, 'uv');
  writeFileSync(executable, `#!${process.execPath}\n${program}\n`);
  chmodSync(executable, 0o700);
  vi.stubEnv('PATH', `${directory}:${process.env['PATH'] ?? ''}`);
  return directory;
}

test('isolated evaluation process gets only allowlisted environment and one JSON result', async () => {
  vi.stubEnv('LANGFUSE_AUTH_HEADER', 'synthetic-private-evaluation-secret');
  const directory = stubUv(`
const fs = require('node:fs');
fs.writeFileSync(require('node:path').join(__dirname, 'child.json'), JSON.stringify({ env: process.env, args: process.argv.slice(2) }));
process.stdout.write(JSON.stringify({ mlflowVersion: '3.18.0', traceIds: ['tr-fixture'] }) + '\\n');
process.stderr.write('sample progress\\n');
`);
  expect(await evaluateSessions(['session-fixture'], 1)).toMatchObject({
    traceIds: ['tr-fixture'],
  });
  const child = JSON.parse(readFileSync(join(directory, 'child.json'), 'utf8')) as {
    env: Record<string, string>;
    args: string[];
  };
  const platformKeys = process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [];
  expect(Object.keys(child.env).sort()).toEqual(
    [
      'DO_NOT_TRACK',
      'HOME',
      'MLFLOW_DISABLE_AGENT_HINT',
      'MLFLOW_DISABLE_TELEMETRY',
      'PATH',
      'TMPDIR',
      ...platformKeys,
    ].sort(),
  );
  expect(child.env['MLFLOW_DISABLE_TELEMETRY']).toBe('true');
  expect(child.env['DO_NOT_TRACK']).toBe('1');
  expect(child.env['MLFLOW_DISABLE_AGENT_HINT']).toBe('1');
  expect(JSON.stringify(child.env)).not.toContain('synthetic-private-evaluation-secret');
  expect(child.args).toEqual([
    'run',
    '--locked',
    '--offline',
    'python',
    '-I',
    'evaluate.py',
    '--tracking-uri',
    'http://127.0.0.1:5100',
    '--experiment-id',
    '1',
    '--expected-traces',
    '1',
    '--session',
    'session-fixture',
  ]);
});

test.each(['stdout', 'stderr'])(
  'generated secret in stub %s is detected before parsing',
  async (channel) => {
    stubUv(`process.${channel}.write('synthetic-private-evaluation-secret');`);
    await expect(evaluateSessions(['session-fixture'], 1)).rejects.toThrow(
      'Evaluation output contains a generated credential',
    );
  },
);

test('extra stdout output cannot be mistaken for the single JSON result', async () => {
  stubUv("process.stdout.write('{}\\n{}\\n');");
  await expect(evaluateSessions(['session-fixture'], 1)).rejects.toThrow(
    'Evaluation must print exactly one JSON line',
  );
});
