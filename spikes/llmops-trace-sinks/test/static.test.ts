// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { envPath, readEnv } from '../src/secrets.js';

const root = fileURLToPath(new URL('../', import.meta.url));
interface Service {
  image: string;
  ports?: (string | { host_ip: string })[];
  environment?: Record<string, string>;
  command?: string[];
  network_mode?: string;
  privileged?: boolean;
  volumes?: (string | { source: string })[];
}
interface Compose {
  services: Record<string, Service>;
}
const compose = parse(readFileSync(resolve(root, 'compose.yaml'), 'utf8')) as Compose;
const collector = parse(readFileSync(resolve(root, 'collector.yaml'), 'utf8'));

function audit(value: Compose): void {
  for (const [name, service] of Object.entries(value.services)) {
    expect(service.image, `${name}: unpinned image`).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(service.network_mode, `${name}: host network`).not.toBe('host');
    expect(service.privileged, `${name}: privileged`).not.toBe(true);
    for (const port of service.ports ?? []) {
      expect(
        typeof port === 'string' ? port.startsWith('127.0.0.1:') : port.host_ip === '127.0.0.1',
        `${name}: non-loopback port`,
      ).toBe(true);
    }
    for (const volume of service.volumes ?? []) {
      expect(
        typeof volume === 'string' ? volume : volume.source,
        `${name}: Docker socket`,
      ).not.toMatch(/docker\.sock/);
    }
    for (const [key, secret] of Object.entries(service.environment ?? {})) {
      if (
        /PASSWORD|SECRET|SALT|ENCRYPTION_KEY|AUTH$|AUTH_HEADER|DATABASE_URL|ACCESS_KEY_ID|MINIO_ROOT_USER|PUBLIC_KEY|USER_EMAIL/.test(
          key,
        )
      ) {
        expect(secret, `${name}: literal ${key}`).toMatch(/^\$\{[A-Z_]+\}$/);
      }
    }
  }
  const mlflow = value.services['mlflow'];
  expect(mlflow).toBeDefined();
  const command = mlflow?.command ?? [];
  expect(command).not.toContain('--disable-security-middleware');
  const hosts = command[command.indexOf('--allowed-hosts') + 1];
  expect(hosts).toBe('mlflow:5100,127.0.0.1:${MLFLOW_PORT:-5100},localhost:${MLFLOW_PORT:-5100}');
  expect(command[command.indexOf('--cors-allowed-origins') + 1]).toBe(
    'http://127.0.0.1:${MLFLOW_PORT:-5100},http://localhost:${MLFLOW_PORT:-5100}',
  );
}

test('compose confines publication, pins images and references secrets', () => audit(compose));

test.each(['literal password', 'unpinned image', 'wildcard port', 'Docker socket', 'host network'])(
  'static guard rejects %s',
  (mutation) => {
    const broken = structuredClone(compose);
    const service = broken.services['postgres'];
    if (!service) throw new Error('Missing postgres service');
    if (mutation === 'literal password') service.environment = { POSTGRES_PASSWORD: 'abc' };
    if (mutation === 'unpinned image') service.image = 'postgres:17';
    if (mutation === 'wildcard port') service.ports = ['5432:5432'];
    if (mutation === 'Docker socket')
      service.volumes = ['/var/run/docker.sock:/var/run/docker.sock'];
    if (mutation === 'host network') service.network_mode = 'host';
    expect(() => audit(broken)).toThrow();
  },
);

test('collector maps only present attributes and fans out without MLflow compression', () => {
  expect(collector.receivers.otlp.protocols.http.endpoint).toBe('0.0.0.0:4318');
  expect(collector.processors.transform.trace_statements[0].statements).toEqual([
    'set(attributes["session.id"], attributes["galaxie.session.id"]) where attributes["galaxie.session.id"] != nil',
    'set(attributes["langfuse.observation.metadata.galaxie.run.id"], attributes["galaxie.run.id"]) where attributes["galaxie.run.id"] != nil',
  ]);
  expect(collector.exporters['otlphttp/mlflow'].compression).toBe('none');
  expect(collector.exporters['otlphttp/langfuse'].headers).toEqual({
    Authorization: '${env:LANGFUSE_AUTH_HEADER}',
    'x-langfuse-ingestion-version': '4',
  });
  expect(collector.exporters['otlphttp/mlflow'].headers).toEqual({
    'x-mlflow-experiment-id': '${env:MLFLOW_EXPERIMENT_ID}',
  });
  expect(collector.service.pipelines.traces).toEqual({
    receivers: ['otlp'],
    processors: ['transform'],
    exporters: ['otlphttp/langfuse', 'otlphttp/mlflow'],
  });
  expect(compose.services['collector']?.environment?.['LANGFUSE_OTEL_ENDPOINT']).toBe(
    '${LANGFUSE_OTEL_ENDPOINT}',
  );
  expect(compose.services['collector']?.environment?.['MLFLOW_OTEL_ENDPOINT']).toBe(
    '${MLFLOW_OTEL_ENDPOINT}',
  );
});

test('version evidence covers every pinned image', () => {
  const evidence = JSON.parse(readFileSync(resolve(root, 'results/versions.json'), 'utf8')) as {
    images: {
      service: string;
      name: string;
      digest: string;
      tag: string;
      pulledRepoDigests: string[];
    }[];
    versions: Record<string, string>;
  };
  expect(evidence.images).toHaveLength(Object.keys(compose.services).length);
  for (const image of evidence.images) {
    expect(compose.services[image.service]?.image).toBe(`${image.name}@${image.digest}`);
    expect(image.pulledRepoDigests.some((digest) => digest.endsWith(`@${image.digest}`))).toBe(
      true,
    );
    expect(image.tag).toBeTruthy();
  }
  expect(evidence.versions['langfuse']).toMatch(/^4\./);
  expect(evidence.versions['mlflow']).toContain('3.18.0');
  expect(evidence.versions['collector']).toContain('0.154.0');
});

test('environment template is empty, ignored secrets stay private and results contain none', () => {
  const template = readFileSync(resolve(root, '.env.example'), 'utf8').trim().split('\n');
  expect(template.every((line) => /^[A-Z_]+=$/.test(line))).toBe(true);
  expect(
    execFileSync('git', ['check-ignore', '.env'], { cwd: root, encoding: 'utf8' }).trim(),
  ).toBe('.env');
  const tracked = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '.'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  expect(tracked).not.toContain('.env');
  expect(tracked).toContain('.env.example');
  if (!existsSync(envPath)) return;
  expect(statSync(envPath).mode & 0o777).toBe(0o600);
  const env = readEnv();
  expect(Object.keys(env).sort()).toEqual(template.map((line) => line.slice(0, -1)).sort());
  expect(env['ENCRYPTION_KEY']).toMatch(/^[a-f0-9]{64}$/);
  expect(env['LANGFUSE_AUTH_HEADER']).toBe(
    `Basic ${Buffer.from(`${env['LANGFUSE_INIT_PROJECT_PUBLIC_KEY']}:${env['LANGFUSE_INIT_PROJECT_SECRET_KEY']}`).toString('base64')}`,
  );
  const results = existsSync(resolve(root, 'results'))
    ? readdirSync(resolve(root, 'results')).map((file) => `results/${file}`)
    : [];
  // Routing values and the short experiment ID are public configuration, not credentials.
  const publicKeys = new Set([
    'MLFLOW_EXPERIMENT_ID',
    'MLFLOW_PORT',
    'MLFLOW_OTEL_ENDPOINT',
    'LANGFUSE_OTEL_ENDPOINT',
  ]);
  for (const file of new Set([...tracked, ...results])) {
    const content = readFileSync(resolve(root, file), 'utf8');
    for (const [key, value] of Object.entries(env)) {
      if (!publicKeys.has(key) && value)
        expect(content.includes(value), `Generated ${key} appears in ${file}`).toBe(false);
    }
  }
});
