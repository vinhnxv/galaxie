// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Request } from 'playwright-core';

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export interface RequestSummary {
  count: number;
  method: string;
  path: string;
  headerNames: string[];
}

const publicSettings = new Set([
  'MLFLOW_EXPERIMENT_ID',
  'MLFLOW_PORT',
  'MLFLOW_OTEL_ENDPOINT',
  'LANGFUSE_OTEL_ENDPOINT',
]);
const forbiddenHeaders = new Set([
  'authorization',
  'x-mlflow-experiment-id',
  'x-langfuse-ingestion-version',
]);

function forms(value: string): string[] {
  return value
    ? [...new Set([value, encodeURIComponent(value), Buffer.from(value).toString('base64')])]
    : [];
}

function text(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
}

function scanSecrets(chunks: readonly string[], env: Record<string, string>): string[] {
  const hits = [];
  for (const [key, value] of Object.entries(env)) {
    if (
      !publicSettings.has(key) &&
      forms(value).some((form) => chunks.some((chunk) => chunk.includes(form)))
    )
      hits.push(`secret:${key}`);
  }
  if (chunks.some((chunk) => /Basic [A-Za-z0-9+/=]{20,}/.test(chunk)))
    hits.push('basic-authorization');
  return hits;
}

export function scanBundle(
  chunks: readonly (string | Uint8Array)[],
  env: Record<string, string>,
): string[] {
  return chunks.flatMap((chunk, index) =>
    scanSecrets([text(chunk)], env).map((hit) => `bundle[${index}]:${hit}`),
  );
}

export function scanRequests(
  requests: readonly CapturedRequest[],
  env: Record<string, string>,
  canary: string,
): string[] {
  return requests.flatMap((request, index) => {
    const chunks = [
      request.url,
      ...Object.keys(request.headers),
      ...Object.values(request.headers),
      request.body === null ? '' : text(request.body),
    ];
    const hits = scanSecrets(chunks, env);
    if (forms(canary).some((form) => chunks.some((chunk) => chunk.includes(form))))
      hits.push('credential-canary');
    for (const name of Object.keys(request.headers))
      if (forbiddenHeaders.has(name.toLowerCase())) hits.push(`header:${name.toLowerCase()}`);
    const id = env['MLFLOW_EXPERIMENT_ID'];
    if (id) {
      const url = new URL(request.url);
      if (
        Object.values(request.headers).some((value) => value === id) ||
        url.pathname.split('/').some((segment) => decodeURIComponent(segment) === id) ||
        [...url.searchParams.values()].some((value) => value === id)
      )
        hits.push('experiment-id');
    }
    return hits.map((hit) => `request[${index}]:${hit}`);
  });
}

export async function captureRequest(
  request: Pick<Request, 'url' | 'method' | 'allHeaders' | 'postDataBuffer'>,
): Promise<CapturedRequest> {
  return {
    url: request.url(),
    method: request.method(),
    headers: await request.allHeaders(),
    body: request.postDataBuffer(),
  };
}

export function summarizeRequests(requests: readonly CapturedRequest[]): RequestSummary[] {
  const groups = new Map<string, RequestSummary>();
  for (const request of requests) {
    const summary = {
      count: 1,
      method: request.method,
      path: new URL(request.url).pathname,
      headerNames: Object.keys(request.headers)
        .map((name) => name.toLowerCase())
        .sort(),
    };
    const key = JSON.stringify([summary.method, summary.path, summary.headerNames]);
    const previous = groups.get(key);
    if (previous) previous.count++;
    else groups.set(key, summary);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, summary]) => summary);
}
