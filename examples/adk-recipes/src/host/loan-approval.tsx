// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type ComponentProps,
  createRegistry,
  defineComponent,
  defineConfirmations,
} from '@galaxie-ai/react';
import { type ReactElement, useEffect, useRef } from 'react';
import {
  LOAN_APPROVAL_COMPONENT,
  loanApprovalProps,
  loanApprovalSummary,
  loanInteractionBindings,
} from '../recipes/loan/interaction.js';

const contract = loanInteractionBindings.components[LOAN_APPROVAL_COMPONENT];
const approveAction = contract?.actions['approve'];
const denyAction = contract?.actions['deny'];
if (!approveAction || !denyAction) throw new Error('The loan approval contract is incomplete.');
const loanActions = {
  approve: { ...approveAction, label: 'Approve' },
  deny: { ...denyAction, label: 'Deny' },
};

function LoanApproval({
  props,
  actions,
  status,
}: ComponentProps<unknown, typeof loanActions>): ReactElement {
  const summary = loanApprovalSummary(props);
  const busy = status === 'submitting' || status === 'accepted';
  const rejected = typeof status === 'object';
  const previous = useRef(rejected);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (rejected && !previous.current) alert.current?.focus();
    previous.current = rejected;
  }, [rejected]);
  return (
    <section aria-label="Loan approval">
      <h2>Review synthetic loan decision</h2>
      <p>
        {summary.company} — {summary.applicant}
      </p>
      <p>Annual revenue: {summary.annualRevenue} demo dollars</p>
      <p>
        Application: {summary.applicationId}; proposed decision: {summary.decision}
      </p>
      <p>
        Approve continues to a separate host confirmation before writing. Deny makes no
        finalization.
      </p>
      {rejected && (
        <p role="alert" ref={alert} tabIndex={-1}>
          The review could not be submitted. Try again.
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void actions.approve.submit({ indexes: [0] });
        }}
      >
        Approve
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void actions.deny.submit({ indexes: [0] });
        }}
      >
        Deny
      </button>
    </section>
  );
}

export const loanRegistry: ReturnType<typeof createRegistry> = createRegistry({
  components: [
    defineComponent({
      id: LOAN_APPROVAL_COMPONENT,
      props: loanApprovalProps,
      actions: loanActions,
      component: LoanApproval,
    }),
  ],
});

export const loanConfirmations: ReturnType<typeof defineConfirmations> = defineConfirmations({
  'loan.finalize@1': {
    title: 'Finalize synthetic loan decision',
    approveLabel: 'Finalize',
    fields: (args) => {
      const summary = loanApprovalSummary(args);
      return [
        { label: 'Company', value: summary.company },
        { label: 'Application', value: summary.applicationId },
        { label: 'Decision', value: summary.decision },
      ];
    },
  },
});
