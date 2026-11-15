// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { AssertionError } from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { readEnv } from './secrets.js';

export interface Observation {
  id: string;
  traceId: string;
  name: string;
  parentObservationId: string | null;
  sessionId: string | null;
  metadata: Record<string, unknown>;
  startTime: string;
  endTime: string;
  type?: string;
  level?: string;
  model?: string | null;
  usageDetails?: Record<string, number>;
  input?: unknown;
  output?: unknown;
}

export interface OtlpSpan {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  attributes: {
    key: string;
    value: OtlpValue;
  }[];
  start_time_unix_nano: number;
  end_time_unix_nano: number;
  status?: { code?: string | number; message?: string };
  kind?: string;
}

export interface OtlpValue {
  string_value?: string;
  int_value?: number;
  double_value?: number;
  bool_value?: boolean;
  array_value?: { values?: OtlpValue[] };
  kvlist_value?: { values?: { key: string; value: OtlpValue }[] };
}

export function decodeValue(value: OtlpValue): unknown {
  if (value.array_value) return (value.array_value.values ?? []).map(decodeValue);
  if (value.kvlist_value)
    return Object.fromEntries(
      (value.kvlist_value.values ?? []).map(({ key, value }) => [key, decodeValue(value)]),
    );
  return value.string_value ?? value.int_value ?? value.double_value ?? value.bool_value ?? null;
}

export interface Readback {
  observations: Observation[];
  traces: { trace_id: string }[];
  spans: OtlpSpan[];
}

async function json<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Readback HTTP ${response.status}: ${new URL(url).pathname}`);
  return (await response.json()) as T;
}

export async function readBack(
  traceId: string,
  inspect?: (response: unknown) => void,
): Promise<Readback> {
  const env = readEnv();
  if (!/^\d{4,5}$/.test(env['MLFLOW_PORT'] ?? '') || Number(env['MLFLOW_PORT']) > 65535)
    throw new Error('Invalid local MLflow port');
  const mlflow = `http://127.0.0.1:${env['MLFLOW_PORT']}`;
  const observations = await observationsQuery({ traceId }, inspect);
  const search = await json<{ traces?: { trace_id: string }[] }>(
    `${mlflow}/api/3.0/mlflow/traces/search`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations: [
          {
            type: 'MLFLOW_EXPERIMENT',
            mlflow_experiment: { experiment_id: env['MLFLOW_EXPERIMENT_ID'] },
          },
        ],
        filter: `trace.request_id = 'tr-${traceId}'`,
        max_results: 100,
      }),
    },
  );
  inspect?.(search);
  const traces = search.traces ?? [];
  if (traces.length === 0) return { observations, traces, spans: [] };
  const detail = await json<{ trace: { spans?: OtlpSpan[] } }>(
    `${mlflow}/api/3.0/mlflow/traces/get?trace_id=${encodeURIComponent(traces[0]?.trace_id ?? '')}`,
  );
  inspect?.(detail);
  return { observations, traces, spans: detail.trace.spans ?? [] };
}

export async function observationsQuery(
  query: Record<string, string>,
  inspect?: (response: unknown) => void,
): Promise<Observation[]> {
  const env = readEnv();
  const all: Observation[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({
      ...query,
      limit: '100',
      fields: 'basic,metadata,time,model,usage,io',
      ...(cursor ? { cursor } : {}),
    });
    const page = await json<{ data: Observation[]; meta: { cursor?: string } }>(
      `http://127.0.0.1:3000/api/public/v2/observations?${params}`,
      { headers: { Authorization: env['LANGFUSE_AUTH_HEADER'] ?? '' } },
    );
    inspect?.(page);
    all.push(...page.data);
    cursor = page.meta.cursor;
  } while (cursor);
  return all;
}

export interface StoredScore {
  id: string;
  name: string;
  value: number;
  timestamp: string;
  subject: { kind: string; id: string; traceId?: string };
}

export const scoreWindowMillis = 300_000;

export async function scoresQuery(
  query: Record<string, string>,
  inspect?: (response: unknown) => void,
): Promise<StoredScore[]> {
  const all: StoredScore[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({
      ...query,
      fields: 'subject',
      limit: '100',
      ...(cursor ? { cursor } : {}),
    });
    const page = await json<{ data: StoredScore[]; meta: { cursor?: string } }>(
      `http://127.0.0.1:3000/api/public/v3/scores?${params}`,
      { headers: { Authorization: readEnv()['LANGFUSE_AUTH_HEADER'] ?? '' } },
    );
    inspect?.(page);
    all.push(...page.data);
    cursor = page.meta.cursor;
  } while (cursor);
  return all;
}

export async function waitForScores(
  query: Record<string, string>,
  expectedCount: number,
  inspect?: (response: unknown) => void,
): Promise<StoredScore[]> {
  const deadline = Date.now() + scoreWindowMillis;
  let latest: StoredScore[] = [];
  let transient: unknown;
  do {
    try {
      latest = await scoresQuery(query, inspect);
      if (latest.length >= expectedCount) return latest;
    } catch (error) {
      if (error instanceof AssertionError) throw error;
      transient = error;
    }
    await setTimeout(1000);
  } while (Date.now() < deadline);
  throw new Error(
    `Score readback timed out after ${scoreWindowMillis}ms: ${latest.length}/${expectedCount}${transient instanceof Error ? ` (${transient.message})` : ''}`,
  );
}

export async function waitForReadback(
  traceId: string,
  spanIds?: readonly string[],
  inspect?: (response: unknown) => void,
): Promise<Readback> {
  const deadline = Date.now() + 90_000;
  let latest: Readback = { observations: [], traces: [], spans: [] };
  let transient: unknown;
  while (Date.now() < deadline) {
    try {
      latest = await readBack(traceId, inspect);
    } catch (error) {
      // Scan failures are results, not transient errors.
      if (error instanceof AssertionError) throw error;
      transient = error;
      await setTimeout(1000);
      continue;
    }
    if (
      spanIds === undefined
        ? latest.observations.length >= 2 && latest.spans.length >= 2
        : spanIds.every(
            (id) =>
              latest.observations.some((span) => span.id === id) &&
              latest.spans.some(
                (span) => Buffer.from(span.span_id, 'base64').toString('hex') === id,
              ),
          )
    )
      return latest;
    await setTimeout(1000);
  }
  throw new Error(
    `Readback timed out${transient instanceof Error ? ` (last transient error: ${transient.message})` : ''}: ${latest.observations.length} observations, ${latest.traces.length} traces, ${latest.spans.length} spans; missing Langfuse: ${spanIds?.filter((id) => !latest.observations.some((span) => span.id === id)).join(', ') ?? 'count'}; missing MLflow: ${spanIds?.filter((id) => !latest.spans.some((span) => Buffer.from(span.span_id, 'base64').toString('hex') === id)).join(', ') ?? 'count'}`,
  );
}
