// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

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
}

export interface OtlpSpan {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  attributes: {
    key: string;
    value: { string_value?: string; int_value?: number; bool_value?: boolean };
  }[];
  start_time_unix_nano: number;
  end_time_unix_nano: number;
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

export async function readBack(traceId: string): Promise<Readback> {
  const env = readEnv();
  if (!/^\d{4,5}$/.test(env['MLFLOW_PORT'] ?? '') || Number(env['MLFLOW_PORT']) > 65535)
    throw new Error('Invalid local MLflow port');
  const mlflow = `http://127.0.0.1:${env['MLFLOW_PORT']}`;
  const observations = await json<{ data: Observation[]; meta: { cursor?: string } }>(
    `http://127.0.0.1:3000/api/public/v2/observations?traceId=${traceId}&limit=100&fields=basic,metadata,time`,
    { headers: { Authorization: env['LANGFUSE_AUTH_HEADER'] ?? '' } },
  );
  if (observations.meta.cursor)
    throw new Error('Unexpected additional observation page for two-span smoke');
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
  const traces = search.traces ?? [];
  if (traces.length === 0) return { observations: observations.data, traces, spans: [] };
  const detail = await json<{ trace: { spans?: OtlpSpan[] } }>(
    `${mlflow}/api/3.0/mlflow/traces/get?trace_id=${encodeURIComponent(traces[0]?.trace_id ?? '')}`,
  );
  return { observations: observations.data, traces, spans: detail.trace.spans ?? [] };
}

export async function waitForReadback(traceId: string): Promise<Readback> {
  const deadline = Date.now() + 120_000;
  let latest: Readback = { observations: [], traces: [], spans: [] };
  while (Date.now() < deadline) {
    latest = await readBack(traceId);
    if (latest.observations.length >= 2 && latest.spans.length >= 2) return latest;
    await setTimeout(1000);
  }
  throw new Error(
    `Readback timed out: ${latest.observations.length} observations, ${latest.traces.length} traces, ${latest.spans.length} spans`,
  );
}
