// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Smoke } from './smoke.js';

export function normalize(value: unknown, smoke: Smoke): unknown {
  const ids = [
    [`tr-${smoke.traceId}`, 'mlflow-trace-1'],
    [smoke.traceId, 'trace-1'],
    [Buffer.from(smoke.traceId, 'hex').toString('base64'), 'trace-1'],
    [smoke.rootId, 'root-span-1'],
    [Buffer.from(smoke.rootId, 'hex').toString('base64'), 'root-span-1'],
    [smoke.childId, 'child-span-1'],
    [Buffer.from(smoke.childId, 'hex').toString('base64'), 'child-span-1'],
    [smoke.sessionId, 'session-1'],
    [smoke.runId, 'run-1'],
  ] as const;
  const times = new Map<string, string>();
  const visit = (item: unknown, key = ''): unknown => {
    if (
      (typeof item === 'number' || typeof item === 'string') &&
      (/time_unix_nano$/.test(key) || /^\d{4}-\d{2}-\d{2}T/.test(String(item)))
    ) {
      const time = String(item);
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
          .filter(([name]) => !/authorization|password|secret|token/i.test(name))
          .map(([name, child]) => [name, visit(child, name)]),
      );
    return item;
  };
  return visit(value);
}
