// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { parallelSources } from './support/dspy-parallel-sources.node.js';
import { executeDspyParallelStep } from './support/dspy-parallel-step.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

test('candidate divergence commits the recovery poison marker instead of preserving the row set', async () => {
  const name = 'par-fan-diverge';
  const firstWorker = await createPythonFixture({
    framework: 'dspy',
    module: 'selected',
    sources: await parallelSources(name, true),
  });
  const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
  try {
    const first = await executeDspyParallelStep(firstWorker.options, firstWorker.agent, store, {
      name,
    });
    expect(first.pending).toBeDefined();
    const rows = structuredClone(store.checkpoints.rows);
    const writes = structuredClone(store.checkpoints.writes);
    const secondWorker = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await parallelSources(name, true, 'removed'),
    });
    try {
      const restored = await executeDspyParallelStep(
        secondWorker.options,
        secondWorker.agent,
        store,
        { name, sessionId: first.sessionId },
      );
      expect(restored.error).toEqual({
        code: 'unrecoverable',
        message: 'Stored state cannot be recovered.',
      });
      expect(restored.modelLabels).toEqual([]);
      expect(restored.calls).toEqual([]);
      expect(restored.postTerminationRequests).toBe(0);
      for (const [key, row] of rows) expect(store.checkpoints.rows.get(key)).toEqual(row);
      for (const [key, value] of writes) expect(store.checkpoints.writes.get(key)).toEqual(value);
      const added = [...store.checkpoints.rows].filter(([key]) => !rows.has(key));
      expect(added).toHaveLength(1);
      const marker = added[0]?.[1];
      expect(marker).toBeDefined();
      expect(JSON.parse(new TextDecoder().decode(marker?.checkpoint.bytes))).toMatchObject({
        status: 'unrecoverable',
        input: null,
        journal: [],
      });
      expect(firstWorker.workerErrors).toEqual([]);
      expect(secondWorker.workerErrors).toEqual([]);
    } finally {
      await secondWorker.cleanup();
    }
  } finally {
    await firstWorker.cleanup();
  }
}, 900000);
