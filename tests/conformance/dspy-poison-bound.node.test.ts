// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { executePoisonRetry } from './support/dspy-poison-retry.js';
import { type PoisonVariant, poisonSources } from './support/dspy-poison-sources.node.js';
import { executeDspyReloadStep } from './support/dspy-restore.js';
import { observeStateBind } from './support/dspy-state-bind.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

for (const variant of ['changed', 'removed'] as const) {
  test(`Node Pyodide refuses public retries of a poisoned session: ${variant}`, async () => {
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    const workers: Awaited<ReturnType<typeof createPythonFixture>>[] = [];
    const lifetime = async (program: PoisonVariant, sessionId?: string, start = false) => {
      const worker = await createPythonFixture({
        framework: 'dspy',
        module: 'selected',
        sources: await poisonSources(program),
      });
      workers.push(worker);
      const observed = observeStateBind(worker.options);
      return {
        worker,
        traffic: observed.traffic,
        result: executeDspyReloadStep(observed.options, worker.agent, store, {
          name: program,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(start ? { start } : {}),
        }),
      };
    };
    const snapshot = () =>
      structuredClone({
        rows: store.checkpoints.rows,
        writes: store.checkpoints.writes,
        journal: store.recovery.journal,
      });
    try {
      const first = await (await lifetime('original')).result;
      expect(first.pending).toBeDefined();
      expect(first.error).toBeUndefined();
      expect(first.calls).toEqual(['before']);
      expect(first.requests).toBe(0);
      const before = snapshot();
      const divergent = await lifetime(variant, first.sessionId);
      const result = await divergent.result;
      expect(result.error).toEqual({
        code: 'unrecoverable',
        message: 'Stored state cannot be recovered.',
      });
      expect(result.calls).toEqual([]);
      expect(result.requests).toBe(0);
      expect(divergent.traffic).toEqual({ models: 0, capabilities: 0, replayed: 0 });
      for (const [key, row] of before.rows) expect(store.checkpoints.rows.get(key)).toEqual(row);
      for (const [key, writes] of before.writes)
        expect(store.checkpoints.writes.get(key)).toEqual(writes);
      expect(store.recovery.journal).toEqual(before.journal);
      const added = [...store.checkpoints.rows].filter(([key]) => !before.rows.has(key));
      expect(added).toHaveLength(1);
      expect(store.checkpoints.writes.size).toBe(before.writes.size + 1);
      const marker = added[0]?.[1];
      const previousId = [...before.rows.values()]
        .map((row) => row.id)
        .sort()
        .at(-1);
      expect(marker?.parentId).toBe(previousId);
      expect(marker?.id).toBe((BigInt(previousId ?? '0') + 1n).toString().padStart(20, '0'));
      expect(JSON.parse(new TextDecoder().decode(marker?.checkpoint.bytes))).toMatchObject({
        status: 'unrecoverable',
        input: null,
        journal: [],
      });
      expect(
        Object.keys(JSON.parse(new TextDecoder().decode(marker?.metadata.bytes))).sort(),
      ).toEqual(['adapter', 'dspy', 'session', 'v']);
      const writes = store.checkpoints.writes.get(added[0]?.[0] ?? '');
      expect(writes).toHaveLength(1);
      expect(writes?.[0]).toMatchObject({
        channel: '__interrupt__',
        index: -3,
        value: { type: 'json' },
      });
      expect(JSON.parse(new TextDecoder().decode(writes?.[0]?.value.bytes))).toBeNull();
      const poisoned = snapshot();
      const restored = await lifetime('original', first.sessionId);
      await expect(restored.result).rejects.toMatchObject({
        code: 'unrecoverable',
        message: 'Stored state cannot be recovered.',
      });
      expect(restored.traffic).toEqual({ models: 0, capabilities: 0, replayed: 0 });
      expect(snapshot()).toEqual(poisoned);
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = await lifetime('original', first.sessionId, true);
        await expect(started.result).rejects.toMatchObject({
          code: 'invalid',
          message: 'An adopted session can only be restored.',
        });
        expect(started.traffic).toEqual({ models: 0, capabilities: 0, replayed: 0 });
        expect(
          started.worker.toWorker
            .map((raw) => JSON.parse(raw))
            .filter(
              (message) => message.kind === 'request' && ['run', 'pending'].includes(message.op),
            ),
        ).toEqual([]);
        expect(snapshot()).toEqual(poisoned);
      }
      for (const worker of workers) expect(worker.workerErrors).toEqual([]);
      console.log(
        JSON.stringify({
          lane: 'Node Pyodide',
          variant,
          firstMarker: 'PASS',
          repeatedExecute: 'UNREACHABLE',
        }),
      );
    } finally {
      for (const worker of workers) await worker.cleanup();
    }
  }, 900000);
}

test('Node Pyodide bounds public starts on the original poisoned instance', async () => {
  const worker = await createPythonFixture({
    framework: 'dspy',
    module: 'selected',
    sources: await poisonSources('same-instance'),
  });
  const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
  const observed = observeStateBind(worker.options);
  try {
    const result = await executePoisonRetry(observed.options, worker.agent, store, async () =>
      JSON.stringify(
        {
          rows: [...store.checkpoints.rows],
          writes: [...store.checkpoints.writes],
          journal: [...store.recovery.journal],
        },
        (_key, value: unknown) => (value instanceof Uint8Array ? [...value] : value),
      ),
    );
    expect(result.errors).toEqual(
      Array.from({ length: 3 }, () => ({
        code: 'unrecoverable',
        message: 'Stored state cannot be recovered.',
      })),
    );
    expect(result.calls).toEqual(['before']);
    expect(result.requests).toBe(0);
    expect(observed.traffic).toEqual({ models: 0, capabilities: 1, replayed: 0 });
    expect(result.snapshots).toHaveLength(3);
    expect(result.snapshots[1]).toBe(result.snapshots[0]);
    expect(result.snapshots[2]).toBe(result.snapshots[0]);
    expect(store.checkpoints.rows.size).toBe(2);
    expect(store.checkpoints.writes.size).toBe(2);
    const marker = [...store.checkpoints.rows.values()].at(-1);
    expect(JSON.parse(new TextDecoder().decode(marker?.checkpoint.bytes))).toMatchObject({
      status: 'unrecoverable',
      input: null,
      journal: [],
    });
    expect(worker.workerErrors).toEqual([]);
  } finally {
    await worker.cleanup();
  }
}, 900000);
