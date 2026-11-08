// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ModelRouting } from '@galaxie-ai/core';
import { MockChatModel, type MockLatch, type MockScriptEntry } from '@galaxie-ai/models/mock';
import { hostModels } from '../../host/runtime.js';

export const LOAN_SAMPLE_PROMPT =
  'Review synthetic application-lantern. This is an invented lending demonstration.';
export const LOAN_FINAL_REPLY =
  'The host receipt records application-lantern as approved and finalized. Synthetic demonstration only.';

export function createLoanMockModels(
  scenario: 'approve' | 'deny' | 'text-only' = 'approve',
  afterWrite?: MockLatch,
): {
  readonly chatModels: Readonly<Record<string, MockChatModel>>;
  readonly routing: ModelRouting;
} {
  const call = (name: string, args: Record<string, unknown>): MockScriptEntry => ({
    id: name,
    text: '',
    toolCalls: [{ id: `${name}_0`, name, args }],
  });
  const scripts: Record<string, MockScriptEntry[]> = {
    extraction: [
      call('get_application_documents', { applicationId: 'application-lantern' }),
      {
        id: 'extracted',
        text: 'application-lantern: Mira Vale, Lantern Orchard Workshop, amount 40000 demo dollars, termMonths 36.',
      },
    ],
    underwriting: [
      call('get_internal_business_data', { applicationId: 'application-lantern' }),
      {
        id: 'underwritten',
        text: 'MATCH: Mira Vale, Lantern Orchard Workshop. annualRevenue 180000; creditScore 750. Synthetic eligibility REVIEW; no real policy.',
      },
    ],
    pricing: [
      call('calculate_loan_pricing', { creditScore: 750, amount: 40000, termMonths: 36 }),
      {
        id: 'priced',
        text: 'Synthetic pricing: tier preferred; annualRatePercent 6.5. No monthly payment or total interest supplied.',
      },
    ],
    decision:
      scenario === 'text-only'
        ? [{ id: 'undecided', text: 'Approved, says the model, without a host write.' }]
        : [
            call('finalize_loan_decision', {
              applicationId: 'application-lantern',
              decision: 'approved',
            }),
            {
              id: 'decision',
              text:
                scenario === 'deny'
                  ? 'Review declined; no decision was finalized.'
                  : LOAN_FINAL_REPLY,
              ...(afterWrite ? { wait: afterWrite } : {}),
            },
          ],
  };
  const descriptor = hostModels('mock').providers['mock'];
  if (!descriptor) throw new Error('The mock descriptor is missing.');
  const chatModels: Record<string, MockChatModel> = {};
  const roles: Record<string, ModelRouting['roles'][string]> = {};
  const providers: Record<string, ModelRouting['providers'][string]> = {};
  for (const [role, replies] of Object.entries(scripts)) {
    chatModels[role] = new MockChatModel(
      { [LOAN_SAMPLE_PROMPT]: replies },
      { sequence: 'assistant-turns' },
    );
    providers[role] = descriptor;
    roles[`loan.${role}`] = { providers: [role], allow: ['in-browser'], maxTokens: 1500 };
  }
  return { chatModels, routing: { providers, roles } };
}
