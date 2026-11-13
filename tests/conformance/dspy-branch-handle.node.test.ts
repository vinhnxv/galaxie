// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { branchHandleSources } from './support/dspy-branch-handle-sources.node.js';
import { executeDspyParallelStep } from './support/dspy-parallel-step.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

test.each([false, true])(
  'branch lock recipe helper=%s preserves bytes and replays with no dispatch',
  async (helper) => {
    const records = [];
    for (const order of ['forward', 'reversed'] as const) {
      const store = {
        checkpoints: new MemoryByteCheckpoints(),
        recovery: new MemoryRecoveryStore(),
      };
      const firstWorker = await createPythonFixture({
        framework: 'dspy',
        module: 'selected',
        sources: branchHandleSources(helper),
      });
      let sessionId: string;
      let pending: unknown;
      try {
        const first = await executeDspyParallelStep(firstWorker.options, firstWorker.agent, store, {
          name: 'branch-lock',
          order,
        });
        expect(first.error).toBeUndefined();
        expect(first.pending).toBeDefined();
        expect(first.modelLabels).toHaveLength(6);
        expect(first.calls).toEqual([]);
        expect(first.streams).toContainEqual({ kind: 'spike-tasks', count: 0 });
        const labels =
          order === 'forward' ? ['alpha', 'beta', 'gamma'] : ['gamma', 'beta', 'alpha'];
        expect(first.completions).toEqual([
          ...labels.map((label) => `${label}:before`),
          ...labels.map((label) => `${label}:last-before`),
        ]);
        const row = [...store.checkpoints.rows.values()].at(-1);
        expect(row).toBeDefined();
        const journal = (
          JSON.parse(new TextDecoder().decode(row?.checkpoint.bytes)) as {
            journal: { fanout?: string }[];
          }
        ).journal;
        expect(journal.slice(0, -1).map((entry) => entry.fanout)).toEqual([
          '0/alpha/0',
          '0/alpha/1',
          '0/beta/0',
          '0/beta/1',
          '0/gamma/0',
          '0/gamma/1',
        ]);
        records.push(row?.checkpoint.bytes);
        sessionId = first.sessionId;
        pending = first.pending;
        expect(first.postTerminationRequests).toBe(0);
        expect(firstWorker.workerErrors).toEqual([]);
      } finally {
        await firstWorker.cleanup();
      }
      const restoredWorker = await createPythonFixture({
        framework: 'dspy',
        module: 'selected',
        sources: branchHandleSources(helper),
      });
      try {
        const restored = await executeDspyParallelStep(
          restoredWorker.options,
          restoredWorker.agent,
          store,
          { name: 'branch-lock', order: order === 'forward' ? 'reversed' : 'forward', sessionId },
        );
        expect(restored.error).toBeUndefined();
        expect(restored.restored).toEqual(pending);
        expect(restored.modelLabels).toEqual([]);
        expect(restored.calls).toEqual([]);
        expect(restored.output).toEqual({
          answers: {
            alpha: ['alpha:before', 'alpha:last-before'],
            beta: ['beta:before', 'beta:last-before'],
            gamma: ['gamma:before', 'gamma:last-before'],
          },
        });
        expect(restored.streams).toContainEqual({ kind: 'replayed', count: 7 });
        expect(restored.streams).toContainEqual({ kind: 'spike-tasks', count: 0 });
        expect(restored.postTerminationRequests).toBe(0);
        expect(restoredWorker.workerErrors).toEqual([]);
      } finally {
        await restoredWorker.cleanup();
      }
    }
    expect(records[0]).toEqual(records[1]);
  },
  900000,
);
