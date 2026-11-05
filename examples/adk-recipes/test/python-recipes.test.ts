// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { auditorDefinition } from '../src/recipes/llm-auditor/definition.js';
import { loanDefinition } from '../src/recipes/loan/definition.js';
import { loanApprovalSummary, loanOutcome } from '../src/recipes/loan/interaction.js';

test('Python recipes declare only their host capabilities and local model roles', () => {
  expect(auditorDefinition.executor).toBe('adk-python');
  expect(Object.keys(auditorDefinition.capabilities?.required ?? {})).toEqual(['market.search@1']);
  expect(loanDefinition.executor).toBe('adk-python');
  expect(Object.keys(loanDefinition.capabilities?.required ?? {})).toEqual([
    'loan.documents@1',
    'loan.business@1',
    'loan.price@1',
    'loan.finalize@1',
  ]);
  for (const definition of [auditorDefinition, loanDefinition])
    for (const role of Object.values(definition.models ?? {}))
      expect(role.defaultPolicy).toBe('local-only');
});

test('the loan approval summary projects trusted fixture fields without documents', () => {
  const pending = { applicationId: 'application-lantern', decision: 'approved' };
  expect(loanApprovalSummary(pending)).toEqual({
    ...pending,
    company: 'Lantern Orchard Workshop',
    applicant: 'Mira Vale',
    annualRevenue: 180000,
  });
  expect(JSON.stringify(loanApprovalSummary(pending))).not.toContain('cutting machines');
  expect(() => loanApprovalSummary({ ...pending, documents: 'raw' })).toThrow();
  expect(() => loanApprovalSummary({ ...pending, applicationId: 'application-missing' })).toThrow();
});

test('only a pending request or host receipt determines the loan outcome', () => {
  expect(loanOutcome('application-lantern', undefined, [])).toEqual({ status: 'undecided' });
  const pending = { applicationId: 'application-lantern', decision: 'approved' };
  expect(loanOutcome('application-lantern', pending, [])).toMatchObject({
    status: 'pending',
    summary: pending,
  });
  const receipt = { ...pending, decision: 'denied' as const, finalized: true as const };
  expect(loanOutcome('application-lantern', undefined, [receipt])).toEqual({
    status: 'finalized',
    receipt,
  });
});

test('a prior receipt for another application cannot finalize the current application', () => {
  const receipt = {
    applicationId: 'application-lantern',
    decision: 'approved' as const,
    finalized: true as const,
  };
  const pending = { applicationId: 'application-cloudberry', decision: 'denied' };
  expect(loanOutcome('application-cloudberry', pending, [receipt])).toMatchObject({
    status: 'pending',
    summary: pending,
  });
  expect(loanOutcome('application-cloudberry', undefined, [receipt])).toEqual({
    status: 'undecided',
  });
  expect(() => loanOutcome('application-lantern', pending, [receipt])).toThrow();
});
