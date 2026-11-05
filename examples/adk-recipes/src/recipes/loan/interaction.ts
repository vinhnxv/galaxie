// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { GalaxieError, type UiBindings } from '@galaxie/core';
import { z } from 'zod';
import businessData from '../../../fixtures/business-data.json' with { type: 'json' };
import { capabilityRequests, type DecisionRecord } from '../../host/capabilities.js';

export const LOAN_APPROVAL_COMPONENT = 'recipes.LoanApproval/v1';
export const loanApprovalProps: z.ZodType<{
  applicationId: string;
  decision: 'approved' | 'denied';
}> = capabilityRequests['loan.finalize@1'].input;
const payload = z.strictObject({ indexes: z.tuple([z.literal(0)]) });

/** Headless registration only. Rendering and explicit human actions belong to the host. */
export const loanInteractionBindings: UiBindings = {
  surfaces: ['main'],
  components: {
    [LOAN_APPROVAL_COMPONENT]: {
      actions: { approve: { payload }, deny: { payload } },
    },
  },
} as const;

export interface LoanApprovalSummary {
  readonly applicationId: string;
  readonly company: string;
  readonly applicant: string;
  readonly annualRevenue: number;
  readonly decision: 'approved' | 'denied';
}

/** Never display a model's prose or raw documents as the approval summary. */
export function loanApprovalSummary(props: unknown): LoanApprovalSummary {
  const parsed = loanApprovalProps.safeParse(props);
  const business = parsed.success
    ? businessData.find((item) => item.applicationId === parsed.data.applicationId)
    : undefined;
  if (!parsed.success || !business)
    throw new GalaxieError('invalid', 'The loan confirmation is invalid.');
  return Object.freeze({
    ...parsed.data,
    company: business.company,
    applicant: business.applicant,
    annualRevenue: business.annualRevenue,
  });
}

export type LoanOutcome =
  | { readonly status: 'undecided' }
  | { readonly status: 'pending'; readonly summary: LoanApprovalSummary }
  | { readonly status: 'finalized'; readonly receipt: DecisionRecord };

/** The host supplies the current application's session receipts, never model text. */
export function loanOutcome(
  applicationId: string,
  pendingProps: unknown | undefined,
  receipts: readonly DecisionRecord[],
): LoanOutcome {
  if (pendingProps !== undefined) {
    const summary = loanApprovalSummary(pendingProps);
    if (summary.applicationId !== applicationId)
      throw new GalaxieError('invalid', 'The loan confirmation is invalid.');
    return { status: 'pending', summary };
  }
  const receipt = receipts.findLast((record) => record.applicationId === applicationId);
  if (receipt) return { status: 'finalized', receipt };
  return { status: 'undecided' };
}
