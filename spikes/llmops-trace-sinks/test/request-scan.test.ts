// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import {
  type CapturedRequest,
  captureRequest,
  scanBundle,
  scanRequests,
  summarizeRequests,
} from '../src/request-scan.js';

const secret = 'synthetic secret /+?';
const auth = `Basic ${Buffer.from('synthetic-public:synthetic-private').toString('base64')}`;
const canary = 'synthetic-routed-credential-canary';
const env = {
  POSTGRES_PASSWORD: secret,
  LANGFUSE_AUTH_HEADER: auth,
  MLFLOW_EXPERIMENT_ID: '7',
  MLFLOW_PORT: '5100',
  MLFLOW_OTEL_ENDPOINT: 'http://mlflow:5100',
  LANGFUSE_OTEL_ENDPOINT: 'http://langfuse-web:3000/api/public/otel',
  EMPTY_SECRET: '',
};
const request = (overrides: Partial<CapturedRequest> = {}): CapturedRequest => ({
  url: 'http://127.0.0.1:4318/otel/v1/traces',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: Buffer.from('{"spans":7}'),
  ...overrides,
});

test('clean bundle and requests ignore public routing settings, empty secrets and numeric bodies', () => {
  expect(
    scanBundle(
      ['Basic library comment; version 7', env.MLFLOW_PORT, env.MLFLOW_OTEL_ENDPOINT],
      env,
    ),
  ).toEqual([]);
  expect(scanRequests([request()], env, canary)).toEqual([]);
});

test.each([
  secret,
  encodeURIComponent(secret),
  Buffer.from(secret).toString('base64'),
  auth,
  encodeURIComponent(auth),
  Buffer.from(auth).toString('base64'),
])('bundle scan detects each secret form without exposing it', (value) => {
  const hits = scanBundle([Buffer.from(`prefix ${value} suffix`)], env);
  expect(hits.length).toBeGreaterThan(0);
  for (const forbidden of [secret, auth, value])
    expect(JSON.stringify(hits)).not.toContain(forbidden);
});

test('the Basic pattern catches a synthetic value absent from the environment', () => {
  const value = `Basic ${Buffer.from('another-public:another-private').toString('base64')}`;
  expect(scanBundle([value], {})).toEqual(['bundle[0]:basic-authorization']);
  expect(scanRequests([request({ body: Buffer.from(value) })], env, canary)).toContain(
    'request[0]:basic-authorization',
  );
});

test.each(['url', 'header', 'body'] as const)(
  'request scan detects raw, encoded and base64 secrets in its %s',
  (location) => {
    for (const value of [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64'),
      auth,
      encodeURIComponent(auth),
      Buffer.from(auth).toString('base64'),
    ]) {
      const captured = request(
        location === 'url'
          ? { url: `http://127.0.0.1/traces?q=${value}` }
          : location === 'header'
            ? { headers: { 'x-fixture': value } }
            : { body: Buffer.from(value) },
      );
      const hits = scanRequests([captured], env, canary);
      expect(hits.length).toBeGreaterThan(0);
      expect(JSON.stringify(hits)).not.toContain(value);
    }
  },
);

test.each(['url', 'header', 'body'] as const)(
  'request scan detects the credential canary in its %s',
  (location) => {
    const captured = request(
      location === 'url'
        ? { url: `http://127.0.0.1/${canary}` }
        : location === 'header'
          ? { headers: { 'x-fixture': canary } }
          : { body: Buffer.from(canary) },
    );
    expect(scanRequests([captured], env, canary)).toContain('request[0]:credential-canary');
  },
);

test.each(['Authorization', 'X-MLflow-Experiment-ID', 'x-langfuse-ingestion-version'])(
  'request scan detects the forbidden %s header regardless of case',
  (name) => {
    expect(scanRequests([request({ headers: { [name]: 'fixture' } })], env, canary)).toContain(
      `request[0]:header:${name.toLowerCase()}`,
    );
  },
);

test.each([
  { url: 'http://127.0.0.1/traces/7' },
  { url: 'http://127.0.0.1/traces?experiment_id=7' },
  { url: 'http://127.0.0.1/traces?experiment_id=%37' },
  { headers: { 'x-fixture': '7' } },
])('experiment ID positive control detects request metadata', (overrides) => {
  expect(scanRequests([request(overrides)], env, canary)).toContain('request[0]:experiment-id');
});

test('request capture keeps full headers and bytes for scanning, and summaries omit values and query strings', async () => {
  const captured = await captureRequest({
    url: () => `http://127.0.0.1:4318/otel/v1/traces?hidden=${secret}`,
    method: () => 'POST',
    allHeaders: async () => ({ 'content-type': 'application/json' }),
    postDataBuffer: () => Buffer.from('synthetic body'),
  });
  expect(captured.body).toEqual(Buffer.from('synthetic body'));
  expect(scanRequests([captured], env, canary)).toContain('request[0]:secret:POSTGRES_PASSWORD');
  expect(summarizeRequests([captured, captured])).toEqual([
    { count: 2, method: 'POST', path: '/otel/v1/traces', headerNames: ['content-type'] },
  ]);
  expect(JSON.stringify(summarizeRequests([captured]))).not.toMatch(
    /synthetic body|hidden|4318|application/,
  );
});

test('a Chromium navigation preference is not an experiment identifier, while a custom identifier header is', () => {
  const numericEnv = { ...env, MLFLOW_EXPERIMENT_ID: '1' };
  const navigation = {
    method: 'GET',
    url: 'http://127.0.0.1:4173/',
    body: null,
    headers: { 'upgrade-insecure-requests': '1', 'sec-fetch-mode': 'navigate' },
  };
  expect(scanRequests([request(navigation)], numericEnv, canary)).toEqual([]);
  // The exemption covers navigations only: the same header on a trace export still counts.
  expect(
    scanRequests([request({ headers: { 'upgrade-insecure-requests': '1' } })], numericEnv, canary),
  ).toContain('request[0]:experiment-id');
  expect(
    scanRequests([request({ headers: { 'x-experiment': '1' } })], numericEnv, canary),
  ).toContain('request[0]:experiment-id');
  expect(
    scanRequests(
      [request({ headers: { 'upgrade-insecure-requests': secret } })],
      numericEnv,
      canary,
    ),
  ).toContain('request[0]:secret:POSTGRES_PASSWORD');
});

test.each([
  ['bare Basic payload', (value: string) => `x=${value.replace(/^Basic /, '')}`],
  [
    'bare payload in base64url form',
    (value: string) =>
      value
        .replace(/^Basic /, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, ''),
  ],
  ['lower-case scheme', (value: string) => value.replace(/^Basic/, 'basic')],
])('scanner detects a %s', (_name, make) => {
  const keyEnv = {
    ...env,
    LANGFUSE_AUTH_HEADER: `Basic ${Buffer.from('pk-lf-synthetic?>:sk-lf-synthetic??').toString('base64')}`,
  };
  const value = make(keyEnv.LANGFUSE_AUTH_HEADER);
  expect(scanBundle([value], keyEnv).length).toBeGreaterThan(0);
  expect(
    scanRequests([request({ body: Buffer.from(value) })], keyEnv, canary).length,
  ).toBeGreaterThan(0);
});

test('a malformed percent escape in a path is reported, not thrown', () => {
  expect(
    scanRequests([request({ url: 'http://127.0.0.1:4318/a/%E0%A4%A/x' })], env, canary),
  ).toContain('request[0]:experiment-id');
});
