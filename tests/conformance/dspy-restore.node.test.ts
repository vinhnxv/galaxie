// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import {
  dspyRejectedRestoreCases,
  dspyReloadCases,
  executeDspyReloadStep,
} from './support/dspy-restore.js';
import { dspySources } from './support/dspy-sources.node.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

test.each(dspyReloadCases)(
  'Node Pyodide restores the durable DSPy journal: %s',
  async (name) => {
    const fixture = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await dspySources(name),
    });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    try {
      let result = await executeDspyReloadStep(fixture.options, fixture.agent, store, { name });
      const calls = [...result.calls];
      const snapshots: Record<string, unknown>[] = [];
      for (let round = 0; result.pending && round < 3; round++) {
        const pending = result.pending;
        snapshots.push(
          JSON.parse(
            new TextDecoder().decode([...store.checkpoints.rows.values()].at(-1)?.checkpoint.bytes),
          ),
        );
        result = await executeDspyReloadStep(fixture.options, fixture.agent, store, {
          name,
          sessionId: result.sessionId,
        });
        expect(result.restored).toEqual(pending);
        calls.push(...result.calls);
      }
      expect(result.pending).toBeUndefined();
      if (!name.startsWith('durable-private-')) expect(result.consumed).toBe(true);
      expect(result.requests).toBe(1);
      expect(calls).toEqual(
        name === 'durable-frontier-write'
          ? ['after']
          : name === 'durable-oversize-completion'
            ? ['before', 'large-0', 'large-1', 'large-2']
            : ['before'],
      );
      if (name.startsWith('durable-private-')) {
        expect(result.error).toEqual({ code: 'denied', message: 'Policy denied the request.' });
        expect(result.output).toBeUndefined();
      } else {
        expect(result.error).toBeUndefined();
        expect(result.output).toEqual({ answer: 'done', receipt: 'RESTORED_CAPABILITY_SECRET' });
        const completed = JSON.parse(
          new TextDecoder().decode([...store.checkpoints.rows.values()].at(-1)?.checkpoint.bytes),
        );
        expect(completed.status).toBe('completed');
        expect([completed.input, completed.journal]).toEqual([null, []]);
        expect(completed.ordinal).toBe(1);
        expect(completed.pauses).toBe(
          ['durable-two', 'durable-large-pauses'].includes(name) ? 2 : 1,
        );
        expect(new Set([...snapshots, completed].map((row) => row['conversation_id'])).size).toBe(
          1,
        );
        if (name === 'durable-oversize-completion') {
          expect(result.streams).not.toContainEqual({ kind: 'checkpoint_dropped' });
          const fresh = await executeDspyReloadStep(fixture.options, fixture.agent, store, {
            name,
            sessionId: result.sessionId,
          });
          expect(fresh.pending).toBeUndefined();
          expect(fresh.calls).toEqual([]);
          expect(fresh.requests).toBe(0);
        }
      }
      expect(
        result.streams.filter((value) => (value as { kind: string }).kind === 'replayed'),
      ).toHaveLength(1);
      expect(fixture.workerErrors).toEqual([]);
      expect(
        [...store.checkpoints.rows.values()].every((row) => row.executor === 'dspy-python'),
      ).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

test.each(dspyRejectedRestoreCases)(
  'a rejected DSPy private URL remains rejected after fresh restore: %s',
  async (name) => {
    const fixture = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await dspySources(name),
    });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    try {
      const first = await executeDspyReloadStep(fixture.options, fixture.agent, store, { name });
      expect(first.error).toEqual({ code: 'denied', message: 'Policy denied the request.' });
      expect(first.pending).toBeUndefined();
      expect(first.requests).toBe(0);
      await expect(
        executeDspyReloadStep(fixture.options, fixture.agent, store, {
          name,
          sessionId: first.sessionId,
        }),
      ).rejects.toMatchObject({ code: 'denied' });
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

test('Node Pyodide reconciles an accepted DSPy answer after reload', async () => {
  const name = 'durable-module';
  const fixture = await createPythonFixture({
    framework: 'dspy',
    module: 'selected',
    sources: await dspySources(name),
  });
  const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
  try {
    const first = await executeDspyReloadStep(fixture.options, fixture.agent, store, {
      name,
      accepted: true,
    });
    const restored = await executeDspyReloadStep(fixture.options, fixture.agent, store, {
      name,
      sessionId: first.sessionId,
    });
    expect(restored.restored).toBeUndefined();
    expect(restored.output).toEqual({ answer: 'done', receipt: 'RESTORED_CAPABILITY_SECRET' });
    expect(restored.calls).toEqual([]);
    expect(restored.consumed).toBe(true);
  } finally {
    await fixture.cleanup();
  }
}, 90000);

test.each(['receipt', 'changed', 'unfinished'] as const)(
  'Node Pyodide recovers a frontier write without repeating it: %s',
  async (fault) => {
    const name = 'durable-frontier-write';
    const sources = await dspySources(name);
    const fixture = await createPythonFixture({ framework: 'dspy', module: 'selected', sources });
    let changedFixture: Awaited<ReturnType<typeof createPythonFixture>> | undefined;
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    try {
      const first = await executeDspyReloadStep(fixture.options, fixture.agent, store, { name });
      const lost = await executeDspyReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
        crashAfterWrite: true,
      });
      expect(lost.crashed).toBe(true);
      expect(lost.calls).toEqual(['after']);
      if (fault === 'unfinished')
        for (const [id, row] of store.recovery.journal)
          store.recovery.journal.set(id, { inputDigest: row.inputDigest, status: 'dispatched' });
      if (fault === 'changed') {
        sources['selected.py'] =
          sources['selected.py']?.replace(
            `factory("${name}")`,
            `factory("${name}", changed=True)`,
          ) ?? '';
        changedFixture = await createPythonFixture({
          framework: 'dspy',
          module: 'selected',
          sources,
        });
      }
      const selected = changedFixture ?? fixture;
      const restored = await executeDspyReloadStep(selected.options, selected.agent, store, {
        name,
        sessionId: first.sessionId,
      });
      expect(restored.calls).toEqual([]);
      expect(store.recovery.journal.size).toBe(1);
      if (fault === 'receipt')
        expect(restored.output).toEqual({ answer: 'done', receipt: 'RESTORED_CAPABILITY_SECRET' });
      else
        expect(restored.error).toMatchObject({
          code: fault === 'changed' ? 'unrecoverable' : 'outcome_unknown',
        });
      if (fault === 'changed') {
        const row = [...store.checkpoints.rows.values()].at(-1);
        expect(JSON.parse(new TextDecoder().decode(row?.checkpoint.bytes)).status).toBe(
          'unrecoverable',
        );
        await expect(
          executeDspyReloadStep(fixture.options, fixture.agent, store, {
            name,
            sessionId: first.sessionId,
          }),
        ).rejects.toMatchObject({ code: 'unrecoverable' });
      }
    } finally {
      await changedFixture?.cleanup();
      await fixture.cleanup();
    }
  },
  90000,
);

test.each(['orphan', 'completion'])(
  'Node Pyodide uses a DSPy checkpoint as the commit marker: %s',
  async (fault) => {
    const name = 'durable-module';
    const fixture = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await dspySources(name),
    });
    const checkpoints = new MemoryByteCheckpoints();
    let failed = false;
    const store = {
      recovery: new MemoryRecoveryStore(),
      checkpoints: {
        async request(value: unknown): Promise<unknown> {
          const input = value as { op: string; parentId?: string | null };
          if (fault === 'completion' && !failed && input.op === 'put' && input.parentId != null) {
            failed = true;
            throw new Error('Private host storage failure.');
          }
          return checkpoints.request(value);
        },
      },
    };
    try {
      const first = await executeDspyReloadStep(fixture.options, fixture.agent, store, { name });
      if (fault === 'orphan')
        await checkpoints.request({
          executor: 'dspy-python',
          op: 'put-writes',
          sessionId: first.sessionId,
          namespace: '',
          id: '00000000000000000002',
          taskId: 'conversation',
          taskPath: '',
          writes: [
            {
              channel: '__interrupt__',
              index: -3,
              interruptIds: ['orphan'],
              value: { type: 'json', bytes: new TextEncoder().encode('{"id":"orphan"}') },
            },
          ],
        });
      let result = await executeDspyReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
      });
      if (fault === 'completion') {
        expect(result.error).toEqual({
          code: 'unavailable',
          message: 'The requested service is unavailable.',
        });
        expect(result.consumed).toBe(false);
        result = await executeDspyReloadStep(fixture.options, fixture.agent, store, {
          name,
          sessionId: first.sessionId,
        });
      }
      expect(result.output).toEqual({ answer: 'done', receipt: 'RESTORED_CAPABILITY_SECRET' });
      expect(result.calls).toEqual([]);
      expect(result.consumed).toBe(true);
      expect(store.recovery.journal.size).toBe(1);
      const completed = [...checkpoints.rows.values()].at(-1);
      expect(completed?.id).toBe('00000000000000000002');
      expect(
        new TextDecoder().decode(
          checkpoints.writes.get(JSON.stringify([first.sessionId, '', completed?.id]))?.[0]?.value
            .bytes,
        ),
      ).toBe('null');
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

test.each([
  'executor-langgraph',
  'executor-pydantic-ai',
  'version',
  'format',
  'session',
  'corrupt',
])(
  'Node Pyodide rejects an incompatible DSPy record and preserves another session: %s',
  async (fault) => {
    const name = 'durable-module';
    const fixture = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await dspySources(name),
    });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    try {
      const first = await executeDspyReloadStep(fixture.options, fixture.agent, store, { name });
      const other = await executeDspyReloadStep(fixture.options, fixture.agent, store, { name });
      if (fault.startsWith('executor-')) {
        const identity = store.recovery.sessions.get(first.sessionId);
        if (!identity) throw new Error('The session identity is missing.');
        store.recovery.sessions.set(first.sessionId, {
          ...identity,
          executorId: fault === 'executor-langgraph' ? 'langgraph-python' : 'pydantic-ai-python',
        });
      } else
        for (const [key, row] of store.checkpoints.rows)
          if (row.sessionId === first.sessionId) {
            const meta = JSON.parse(new TextDecoder().decode(row.metadata.bytes));
            if (fault === 'version') meta.dspy = '0.0.0';
            if (fault === 'format') meta.v = 2;
            if (fault === 'session') meta.session = other.sessionId;
            store.checkpoints.rows.set(key, {
              ...row,
              metadata: { ...row.metadata, bytes: new TextEncoder().encode(JSON.stringify(meta)) },
              ...(fault === 'corrupt'
                ? { checkpoint: { ...row.checkpoint, bytes: new TextEncoder().encode('corrupt') } }
                : {}),
            });
          }
      const before = fixture.fromWorker.length;
      await expect(
        executeDspyReloadStep(fixture.options, fixture.agent, store, {
          name,
          sessionId: first.sessionId,
        }),
      ).rejects.toMatchObject({
        code: fault.startsWith('executor-') ? 'unsupported' : 'unrecoverable',
        ...(fault.startsWith('executor-')
          ? { message: 'The saved session uses a different executor.' }
          : {}),
      });
      if (fault.startsWith('executor-'))
        expect(
          fixture.fromWorker.slice(before).some((raw) => JSON.parse(raw).op === 'checkpoint'),
        ).toBe(false);
      const restored = await executeDspyReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: other.sessionId,
      });
      expect(restored.restored).toEqual(other.pending);
      expect(restored.output).toBeDefined();
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);
