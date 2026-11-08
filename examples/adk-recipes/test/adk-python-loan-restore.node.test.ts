// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createMockLatch } from '@galaxie-ai/models/mock';
import { expect, test } from 'vitest';
import { MemoryRecoveryStore } from '../../../packages/core/test/support/memory-recovery-store.js';
import { MemoryByteCheckpoints } from '../../../tests/conformance/support/memory-byte-checkpoints.js';
import { LOAN_FINAL_REPLY } from '../src/recipes/loan/script.js';
import { answerLoan, openLoan, startLoan } from './support/python.js';
import { pythonWheelsAvailable, recipeFixture } from './support/python.node.js';

test.skipIf(!pythonWheelsAvailable).each([false, true])(
  'fresh Python Workers restore the same loan pause and replay an approved receipt after loss: %s',
  async (loseWorker) => {
    const fixture = await recipeFixture('loan');
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    let first: Awaited<ReturnType<typeof openLoan>> | undefined;
    const wait = createMockLatch();
    try {
      first = await openLoan(fixture.options, fixture.agent, store);
      const initial = await startLoan(first);
      const pending = initial.observation.pending;
      if (!pending) throw new Error('The first pause is missing.');
      const sessionId = first.instance.sessionId;
      await first.runtime.dispose();
      const second = await openLoan(fixture.options, fixture.agent, store, {
        sessionId,
        capabilities: first.capabilities,
        ...(loseWorker ? { afterWrite: wait } : {}),
      });
      try {
        const restored = await startLoan(second, true);
        expect(restored.observation.pending).toEqual(pending);
        expect(second.calls).toEqual([]);
        const resumed = answerLoan(second, restored.runId, pending, 'approve');
        if (loseWorker) {
          await wait.entered;
          expect(second.capabilities.decisions()).toHaveLength(1);
          await second.runtime.dispose();
          wait.release();
          await resumed;
          const third = await openLoan(fixture.options, fixture.agent, store, {
            sessionId,
            capabilities: first.capabilities,
          });
          try {
            const replay = await startLoan(third, true);
            expect(replay.observation.error).toBeUndefined();
            expect(replay.observation.output).toBe(LOAN_FINAL_REPLY);
            expect(third.calls).toEqual([]);
            expect(third.outcome()).toMatchObject({
              status: 'finalized',
              receipt: { decision: 'approved' },
            });
          } finally {
            await third.runtime.dispose();
          }
        } else {
          const completed = await resumed;
          expect(completed.error).toBeUndefined();
          expect(completed.output).toBe(LOAN_FINAL_REPLY);
          expect(second.calls).toEqual(['loan.finalize@1']);
        }
        expect(store.recovery.journal.size).toBe(1);
        expect([...store.recovery.journal.values()][0]?.status).toBe('succeeded');
        expect(
          (await store.recovery.submissions(sessionId)).every(
            (entry) => entry.status === 'consumed',
          ),
        ).toBe(true);
        expect(first.capabilities.decisions()).toHaveLength(1);
      } finally {
        await second.runtime.dispose();
      }
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      wait.release();
      await first?.runtime.dispose();
      await fixture.cleanup();
    }
  },
  180000,
);
