// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export const envPath = new URL('../.env', import.meta.url);

export function readEnv(path: URL = envPath): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const offset = line.indexOf('=');
        return [line.slice(0, offset), line.slice(offset + 1)];
      }),
  );
}

export function ensureEnv(): Record<string, string> {
  if (!existsSync(envPath)) {
    const secret = (): string => randomBytes(32).toString('hex');
    const publicKey = `pk-lf-${randomUUID()}`;
    const secretKey = `sk-lf-${secret()}`;
    const databasePassword = secret();
    const values: Record<string, string> = {
      POSTGRES_PASSWORD: databasePassword,
      DATABASE_URL: `postgresql://postgres:${databasePassword}@postgres:5432/postgres`,
      CLICKHOUSE_PASSWORD: secret(),
      REDIS_AUTH: secret(),
      MINIO_ROOT_USER: `local-${randomBytes(8).toString('hex')}`,
      MINIO_ROOT_PASSWORD: secret(),
      NEXTAUTH_SECRET: secret(),
      SALT: secret(),
      ENCRYPTION_KEY: secret(),
      LANGFUSE_INIT_PROJECT_PUBLIC_KEY: publicKey,
      LANGFUSE_INIT_PROJECT_SECRET_KEY: secretKey,
      LANGFUSE_INIT_USER_EMAIL: `local-${randomUUID()}@example.invalid`,
      LANGFUSE_INIT_USER_PASSWORD: secret(),
      LANGFUSE_AUTH_HEADER: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
      LANGFUSE_OTEL_ENDPOINT: 'http://langfuse-web:3000/api/public/otel',
      MLFLOW_OTEL_ENDPOINT: 'http://mlflow:5100',
      MLFLOW_PORT: '5100',
      MLFLOW_EXPERIMENT_ID: '',
    };
    writeFileSync(
      envPath,
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
      { mode: 0o600, flag: 'wx' },
    );
  }
  chmodSync(envPath, 0o600);
  return readEnv();
}

export function setExperimentId(id: string): void {
  if (id !== '' && !/^\d+$/.test(id)) throw new Error('Invalid MLflow experiment ID');
  const current = readFileSync(envPath, 'utf8');
  if (!/^MLFLOW_EXPERIMENT_ID=.*$/m.test(current))
    throw new Error('Missing experiment ID key in .env');
  writeFileSync(
    envPath,
    current.replace(/^MLFLOW_EXPERIMENT_ID=.*$/m, `MLFLOW_EXPERIMENT_ID=${id}`),
    { mode: 0o600 },
  );
}

export function redact(text: string): string {
  if (!existsSync(envPath)) return text;
  let result = text;
  for (const value of Object.values(readEnv())
    .filter((value) => value.length >= 8)
    .sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(value, '[redacted]');
  }
  return result;
}
