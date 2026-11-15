// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { normalize } from '../src/normalize.js';
import { runSessions } from '../src/scenarios.js';

test.each([false, true])(
  'two sessions run three sequential starts with session copy %s',
  async (sessionCopy) => {
    const result = await runSessions({ text: false, live: false, sessionCopy });
    expect(result.spans).toHaveLength(18);
    expect(result.runTrace).toHaveLength(6);
    const sessions = [...new Set(result.runTrace.map((entry) => entry.sessionId))];
    expect(sessions).toHaveLength(2);
    for (const sessionId of sessions) {
      const entries = result.runTrace.filter((entry) => entry.sessionId === sessionId);
      expect(new Set(entries.map((entry) => entry.runId)).size).toBe(3);
      expect(new Set(entries.map((entry) => entry.traceId)).size).toBe(3);
    }
    for (const span of result.spans) {
      const entry = result.runTrace.find((entry) => entry.traceId === span.spanContext().traceId);
      expect(span.attributes['session.id']).toBe(sessionCopy ? entry?.sessionId : undefined);
      expect(typeof span.attributes['galaxie.session.id'] === 'string').toBe(
        span.name.startsWith('invoke_agent '),
      );
    }
    expect(
      normalize(
        result.runTrace.map((entry) => ({ runId: entry.runId, sessionId: entry.sessionId })),
        result.spans,
      ),
    ).toEqual([
      { runId: 'run-1', sessionId: 'session-1' },
      { runId: 'run-2', sessionId: 'session-1' },
      { runId: 'run-3', sessionId: 'session-1' },
      { runId: 'run-4', sessionId: 'session-2' },
      { runId: 'run-5', sessionId: 'session-2' },
      { runId: 'run-6', sessionId: 'session-2' },
    ]);
  },
);
