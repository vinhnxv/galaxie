// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { type PoisonVariant, poisonSources } from './support/dspy-poison-sources.node.js';
import { executeDspyReloadStep } from './support/dspy-restore.js';
import { observeStateBind } from './support/dspy-state-bind.js';
import { expectedBinding, readBinding } from './support/dspy-state-binding.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

for (const change of ['python', 'json', 'request', 'python-only'] as const) {
  test(`Node Pyodide pins the Python data-module binding alternative: ${change}`, async () => {
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    const workers: Awaited<ReturnType<typeof createPythonFixture>>[] = [];
    const program: PoisonVariant = change === 'request' ? 'data-request' : 'data';
    const lifetime = async (sessionId?: string, catalog = 'before', json = '{}') => {
      const sources = await poisonSources(
        program,
        catalog,
        change === 'python-only' ? undefined : json,
      );
      const worker = await createPythonFixture({ framework: 'dspy', module: 'selected', sources });
      workers.push(worker);
      const observed = observeStateBind(worker.options);
      return {
        sources,
        traffic: observed.traffic,
        result: executeDspyReloadStep(observed.options, worker.agent, store, {
          name: program,
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      };
    };
    try {
      const paused = await lifetime();
      const first = await paused.result;
      expect(first.pending).toBeDefined();
      expect(first.error).toBeUndefined();
      expect(first.calls).toEqual(['before']);
      expect(first.requests).toBe(0);
      expect(readBinding(store.checkpoints.rows)).toBe(expectedBinding(paused.sources));
      const metadata = JSON.parse(
        new TextDecoder().decode([...store.checkpoints.rows.values()].at(-1)?.metadata.bytes),
      );
      if (change === 'python-only') {
        expect(Object.keys(metadata).sort()).toEqual(['adapter', 'dspy', 'session', 'v']);
        const row = [...store.checkpoints.rows.values()].at(-1);
        expect(new TextDecoder().decode(row?.metadata.bytes)).toBe(
          JSON.stringify({
            v: 1,
            dspy: metadata.dspy,
            adapter: metadata.adapter,
            session: metadata.session,
          }),
        );
      } else
        expect(readBinding(store.checkpoints.rows)).toBe(
          expectedBinding({ 'unrelated.json': '{}' }),
        );
      const saved = structuredClone({
        rows: store.checkpoints.rows,
        writes: store.checkpoints.writes,
        journal: store.recovery.journal,
      });
      const changed = await lifetime(
        first.sessionId,
        change === 'json' ? 'before' : 'edited',
        change === 'json' ? '[]' : '{}',
      );
      if (change === 'json') {
        await expect(changed.result).rejects.toMatchObject({
          code: 'unrecoverable',
          message: 'Stored state cannot be recovered.',
        });
        expect(changed.traffic).toEqual({ models: 0, capabilities: 0, replayed: 0 });
        expect({
          rows: store.checkpoints.rows,
          writes: store.checkpoints.writes,
          journal: store.recovery.journal,
        }).toEqual(saved);
        const rollback = await lifetime(first.sessionId);
        const completed = await rollback.result;
        expect(completed.error).toBeUndefined();
        expect(completed.output).toEqual({ answer: 'done', catalog: 'before' });
        expect(rollback.traffic).toEqual({ models: 1, capabilities: 1, replayed: 1 });
      } else if (change === 'request') {
        const result = await changed.result;
        expect(result.error).toEqual({
          code: 'unrecoverable',
          message: 'Stored state cannot be recovered.',
        });
        expect(result.calls).toEqual([]);
        expect(result.requests).toBe(0);
        expect(changed.traffic).toEqual({ models: 0, capabilities: 0, replayed: 0 });
        expect(store.checkpoints.rows.size).toBe(saved.rows.size + 1);
        for (const [key, row] of saved.rows) expect(store.checkpoints.rows.get(key)).toEqual(row);
        const last = [...store.checkpoints.rows.values()].at(-1);
        expect(JSON.parse(new TextDecoder().decode(last?.checkpoint.bytes)).status).toBe(
          'unrecoverable',
        );
      } else {
        const result = await changed.result;
        expect(result.error).toBeUndefined();
        expect(result.pending).toBeUndefined();
        expect(result.restored).toEqual(first.pending);
        expect(result.output).toEqual({ answer: 'done', catalog: 'edited' });
        expect(result.calls).toEqual(['after']);
        expect(result.requests).toBe(1);
        expect(changed.traffic).toEqual({ models: 1, capabilities: 1, replayed: 1 });
      }
      for (const worker of workers) expect(worker.workerErrors).toEqual([]);
    } finally {
      for (const worker of workers) await worker.cleanup();
    }
  }, 900000);
}
