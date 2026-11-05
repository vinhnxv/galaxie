// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { MemoryRecoveryStore } from '../../../packages/core/test/support/memory-recovery-store.js';
import { MemoryByteCheckpoints } from '../../../tests/conformance/support/memory-byte-checkpoints.js';
import { loanApprovalSummary } from '../src/recipes/loan/interaction.js';
import { LOAN_FINAL_REPLY } from '../src/recipes/loan/script.js';
import { answerLoan, openLoan, startLoan } from './support/python.js';
import { pythonWheelsAvailable, recipeFixture } from './support/python.node.js';

test.skipIf(!pythonWheelsAvailable).each(['approve', 'deny', 'text-only'] as const)(
  'the Python loan pipeline uses host pricing and receipt-based outcomes: %s',
  async (scenario) => {
    const fixture = await recipeFixture('loan');
    let host: Awaited<ReturnType<typeof openLoan>> | undefined;
    try {
      host = await openLoan(
        fixture.options,
        fixture.agent,
        {
          checkpoints: new MemoryByteCheckpoints(),
          recovery: new MemoryRecoveryStore(),
        },
        { scenario },
      );
      const { runId, observation } = await startLoan(host);
      expect(observation.error).toBeUndefined();
      expect(host.calls).toEqual(['loan.documents@1', 'loan.business@1', 'loan.price@1']);
      if (scenario === 'text-only') {
        expect(observation.status).toBe('succeeded');
        expect(observation.pending).toBeUndefined();
        expect(observation.output).toContain('Approved');
        expect(host.outcome()).toEqual({ status: 'undecided' });
      } else {
        const pending = observation.pending;
        if (!pending) throw new Error('The approval is missing.');
        expect(host.outcome(pending)).toMatchObject({ status: 'pending' });
        expect(loanApprovalSummary(pending.props)).toMatchObject({
          applicationId: 'application-lantern',
          company: 'Lantern Orchard Workshop',
          annualRevenue: 180000,
        });
        expect(Object.keys(loanApprovalSummary(pending.props))).not.toContain('documents');
        // An unrecognized interaction is rejected by core before any resume or write.
        const rejected = await host.instance.dispatch({
          instanceId: host.instance.instanceId,
          runId,
          ...pending,
          interactionId: 'wrong' as typeof pending.interactionId,
          action: 'approve',
          payload: { indexes: [0] },
        });
        expect(rejected).toMatchObject({ status: 'rejected', error: { code: 'stale' } });
        expect(
          await host.instance.dispatch({
            instanceId: host.instance.instanceId,
            runId,
            ...pending,
            action: 'approve',
            payload: { indexes: [1] },
          }),
        ).toMatchObject({ status: 'rejected', error: { code: 'invalid' } });
        expect(host.capabilities.decisions()).toEqual([]);
        const final = await answerLoan(host, runId, pending, scenario);
        expect(final.status).toBe('succeeded');
        expect(final.error).toBeUndefined();
        expect(final.output).toBe(
          scenario === 'approve' ? LOAN_FINAL_REPLY : 'Review declined; no decision was finalized.',
        );
        expect(host.calls.filter((name) => name === 'loan.finalize@1')).toHaveLength(
          scenario === 'approve' ? 1 : 0,
        );
        expect(host.outcome().status).toBe(scenario === 'approve' ? 'finalized' : 'undecided');
        expect(
          await host.instance.dispatch({
            instanceId: host.instance.instanceId,
            runId,
            ...pending,
            action: 'approve',
            payload: { indexes: [0] },
          }),
        ).toMatchObject({ status: 'rejected', error: { code: 'duplicate' } });
      }
      const requests = fixture.fromWorker
        .map((raw) => JSON.parse(raw))
        .filter((frame) => frame.op === 'model');
      const underwriting = JSON.stringify(
        requests.find((frame) => frame.payload.role === 'loan.underwriting'),
      );
      const pricing = JSON.stringify(
        requests.find((frame) => frame.payload.role === 'loan.pricing'),
      );
      const decision = JSON.stringify(
        requests.find((frame) => frame.payload.role === 'loan.decision'),
      );
      expect(underwriting).toContain('termMonths 36');
      expect(pricing).toContain('creditScore 750');
      expect(decision).toContain('annualRatePercent 6.5');
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await host?.runtime.dispose();
      await fixture.cleanup();
    }
  },
  90000,
);
