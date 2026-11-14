// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { randomBytes, randomUUID } from 'node:crypto';

export interface Smoke {
  traceId: string;
  rootId: string;
  childId: string;
  sessionId: string;
  runId: string;
  payload: unknown;
}

export function makeSmoke(): Smoke {
  const traceId = randomBytes(16).toString('hex');
  const rootId = randomBytes(8).toString('hex');
  const childId = randomBytes(8).toString('hex');
  const sessionId = randomUUID();
  const runId = randomUUID();
  const start = BigInt(Date.now()) * 1_000_000n;
  const attribute = (key: string, value: string | number | boolean): unknown => ({
    key,
    value:
      typeof value === 'string'
        ? { stringValue: value }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : { intValue: String(value) },
  });
  const common = [
    attribute('smoke.string', 'local-only'),
    attribute('smoke.number', 7),
    attribute('smoke.boolean', true),
  ];
  const spans = [
    {
      traceId,
      spanId: rootId,
      name: 'smoke-root',
      kind: 1,
      startTimeUnixNano: start.toString(),
      endTimeUnixNano: (start + 10_000_000n).toString(),
      status: { code: 1 },
      attributes: [
        ...common,
        attribute('galaxie.session.id', sessionId),
        attribute('galaxie.run.id', runId),
      ],
    },
    {
      traceId,
      spanId: childId,
      parentSpanId: rootId,
      name: 'smoke-child',
      kind: 1,
      startTimeUnixNano: (start + 1_000_000n).toString(),
      endTimeUnixNano: (start + 5_000_000n).toString(),
      status: { code: 1 },
      attributes: common,
    },
  ];
  return {
    traceId,
    rootId,
    childId,
    sessionId,
    runId,
    payload: {
      resourceSpans: [
        {
          resource: { attributes: [attribute('service.name', 'galaxie-llmops-smoke')] },
          scopeSpans: [{ scope: { name: 'galaxie.llmops.smoke' }, spans }],
        },
      ],
    },
  };
}

export async function postSmoke(smoke: Smoke): Promise<void> {
  const response = await fetch('http://127.0.0.1:4318/v1/traces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(smoke.payload),
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Collector rejected smoke: HTTP ${response.status}`);
  const body = (await response.json()) as { partialSuccess?: { rejectedSpans?: string | number } };
  if (Number(body.partialSuccess?.rejectedSpans ?? 0) !== 0)
    throw new Error('Collector partially rejected smoke spans');
}
