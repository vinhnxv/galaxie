// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import type { Smoke } from './smoke.js';

export function normalize(value: unknown, source: Smoke | readonly ReadableSpan[]): unknown {
  const ids: (readonly [string, string])[] = [];
  if (Array.isArray(source)) {
    const traces = new Map<string, string>();
    const identities = new Set<string>();
    const counts = new Map<string, number>();
    for (const [index, span] of source.entries()) {
      const { traceId, spanId } = span.spanContext();
      if (!traces.has(traceId)) traces.set(traceId, `trace-${traces.size + 1}`);
      const trace = traces.get(traceId) ?? '';
      ids.push(
        [`tr-${traceId}`, `mlflow-${trace}`],
        [traceId, trace],
        [Buffer.from(traceId, 'hex').toString('base64'), trace],
        [spanId, `span-${index + 1}`],
        [Buffer.from(spanId, 'hex').toString('base64'), `span-${index + 1}`],
      );
      for (const kind of ['run', 'session', 'instance']) {
        const id = span.attributes[`galaxie.${kind}.id`];
        if (typeof id === 'string' && !identities.has(id)) {
          identities.add(id);
          const count = (counts.get(kind) ?? 0) + 1;
          counts.set(kind, count);
          ids.push([id, `${kind}-${count}`]);
        }
      }
    }
  } else {
    const smoke = source as Smoke;
    ids.push(
      ...([
        [`tr-${smoke.traceId}`, 'mlflow-trace-1'],
        [smoke.traceId, 'trace-1'],
        [Buffer.from(smoke.traceId, 'hex').toString('base64'), 'trace-1'],
        [smoke.rootId, 'root-span-1'],
        [Buffer.from(smoke.rootId, 'hex').toString('base64'), 'root-span-1'],
        [smoke.childId, 'child-span-1'],
        [Buffer.from(smoke.childId, 'hex').toString('base64'), 'child-span-1'],
        [smoke.sessionId, 'session-1'],
        [smoke.runId, 'run-1'],
      ] as const),
    );
  }
  const times = new Map<string, string>();
  const visit = (item: unknown, key = ''): unknown => {
    if (
      (typeof item === 'number' || typeof item === 'string') &&
      (/time_unix_nano$/.test(key) || /^\d{4}-\d{2}-\d{2}T/.test(String(item)))
    ) {
      const time = String(item);
      if (Array.isArray(source)) return '<timestamp>';
      if (!times.has(time)) times.set(time, `time-${times.size + 1}`);
      return times.get(time);
    }
    if (typeof item === 'string') {
      let text = item;
      for (const [id, label] of ids) text = text.replaceAll(id, label);
      return text;
    }
    if (Array.isArray(item)) return item.map((child) => visit(child));
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .filter(
            ([name]) =>
              !/authorization|password|secret|^(?:access_|refresh_|id_|api_)?token$/i.test(name),
          )
          .map(([name, child]) => [name, visit(child, name)]),
      );
    return item;
  };
  return visit(value);
}
