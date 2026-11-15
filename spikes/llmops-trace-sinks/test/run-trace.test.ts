// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import { normalize } from '../src/normalize.js';
import { RunTraceMap } from '../src/run-trace.js';
import { runScenario, scenarios } from '../src/scenarios.js';

test.each(['linear', 'interrupt-resume'] as const)(
  'maps each %s root at span start',
  async (name) => {
    const result = await runScenario(name, { text: false, live: false });
    const roots = result.spans.filter((span) => span.name.startsWith('invoke_agent '));
    expect(result.runTrace).toHaveLength(name === 'linear' ? 1 : 2);
    for (const root of roots)
      expect(result.runTrace).toContainEqual({
        traceId: root.spanContext().traceId,
        runId: result.runId,
        segment: root.attributes['galaxie.run.segment'],
        sessionId: root.attributes['galaxie.session.id'],
      });
    expect(new Set(result.runTrace.map((entry) => entry.traceId)).size).toBe(roots.length);
  },
);

test('session copy is optional and covers children in both resumed traces', async () => {
  for (const sessionCopy of [false, true]) {
    const result = await runScenario('interrupt-resume', { text: false, live: false, sessionCopy });
    for (const span of result.spans) {
      const root = result.runTrace.find((entry) => entry.traceId === span.spanContext().traceId);
      expect(span.attributes['session.id']).toBe(sessionCopy ? root?.sessionId : undefined);
    }
  }
});

test.each(scenarios)(
  'the map leaves %s span content unchanged in either text mode',
  async (name) => {
    for (const text of [false, true]) {
      const mapped = await runScenario(name, { live: false, text });
      const disabled = vi.spyOn(RunTraceMap.prototype, 'onStart').mockImplementation(() => {});
      try {
        const baseline = await runScenario(name, { live: false, text });
        const content = (result: typeof mapped): unknown =>
          normalize(
            result.spans.map((span) => ({
              name: span.name,
              kind: span.kind,
              attributes: span.attributes,
              status: span.status,
              context: span.spanContext(),
              parent: span.parentSpanContext,
            })),
            result.spans,
          );
        expect(content(mapped)).toEqual(content(baseline));
        expect(baseline.runTrace).toEqual([]);
      } finally {
        disabled.mockRestore();
      }
    }
  },
);
