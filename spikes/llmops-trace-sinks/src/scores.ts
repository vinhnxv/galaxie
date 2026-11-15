// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { AssertionError } from 'node:assert/strict';
import type { RunTrace, RunTraceMap } from './run-trace.js';

export interface ScorePayload {
  id: string;
  traceId: string;
  name: string;
  value: number;
  dataType: 'NUMERIC';
  timestamp: string;
}
export type ScoreOutcome =
  | { status: 'posted'; id: string; httpStatus: number }
  | { status: 'unmapped'; reason: 'run-not-seen' | 'segment-not-seen' }
  | { status: 'rejected'; httpStatus: number }
  | { status: 'transport-error' };

export function scoreId(traceId: string, name: string): string {
  if (!/^[a-z0-9_.-]{1,64}$/.test(name)) throw new Error('Invalid score name');
  return `${traceId}-${name}`;
}

export function createScoreClient(options: {
  baseUrl?: string;
  authorization: string;
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
}): {
  post(entry: Pick<RunTrace, 'traceId'>, name: string, value: number): Promise<ScoreOutcome>;
  scoreRun(
    map: RunTraceMap,
    runId: string,
    segment: number,
    name: string,
    value: number,
  ): Promise<ScoreOutcome>;
} {
  const base = options.baseUrl ?? 'http://127.0.0.1:3000';
  if (new URL(base).origin !== 'http://127.0.0.1:3000')
    throw new Error('Score endpoint must be the local Langfuse backend');
  const stored = new Map<string, string>();
  const post = async (
    entry: Pick<RunTrace, 'traceId'>,
    name: string,
    value: number,
  ): Promise<ScoreOutcome> => {
    const id = scoreId(entry.traceId, name);
    if (!Number.isFinite(value)) throw new Error('Invalid score value');
    if (!stored.has(id)) {
      const payload: ScorePayload = {
        id,
        traceId: entry.traceId,
        name,
        value,
        dataType: 'NUMERIC',
        timestamp: (options.clock?.() ?? new Date()).toISOString(),
      };
      stored.set(id, JSON.stringify([payload]));
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await (options.fetch ?? globalThis.fetch)(`${base}/api/public/scores`, {
          method: 'POST',
          headers: { Authorization: options.authorization, 'Content-Type': 'application/json' },
          body: stored.get(id) ?? '',
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        await response.body?.cancel();
        if (response.status === 202) return { status: 'posted', id, httpStatus: response.status };
        if (response.status < 500) return { status: 'rejected', httpStatus: response.status };
      } catch (error) {
        if (error instanceof AssertionError) throw error;
      }
    }
    return { status: 'transport-error' };
  };
  return {
    post,
    async scoreRun(map, runId, segment, name, value) {
      const entry = map.lookup(runId, segment);
      return entry
        ? post(entry, name, value)
        : { status: 'unmapped', reason: map.hasRun(runId) ? 'segment-not-seen' : 'run-not-seen' };
    },
  };
}
