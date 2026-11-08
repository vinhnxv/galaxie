// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ModelRouting } from '@galaxie-ai/core';
import { MockChatModel, type MockScript } from '@galaxie-ai/models/mock';
import { hostModels } from '../../host/runtime.js';
import { LEGAL_DISCLAIMER } from './disclaimer.js';

export const FINANCIAL_SAMPLE_PROMPT: string =
  'Analyze the invented company Lantern Orchard Workshop (demo ticker LANTERN). Risk attitude: conservative. Investment period: long-term. Execution preferences: paper trading only, no broker.';
export const FINANCIAL_EMPTY_PROMPT: string =
  'Analyze the invented company Unknown Demo Company (demo ticker UNKNOWN). Risk attitude: conservative. Investment period: long-term. Execution preferences: paper trading only, no broker.';

/** Authored replies demonstrate orchestration only; they do not measure model behavior. */
export function createFinancialMockModels(): {
  readonly chatModels: Readonly<Record<string, MockChatModel>>;
  readonly routing: ModelRouting;
} {
  const scripts: Record<string, MockScript> = {};
  for (const [prompt, company, empty] of [
    [FINANCIAL_SAMPLE_PROMPT, 'Lantern Orchard Workshop', false],
    [FINANCIAL_EMPTY_PROMPT, 'Unknown Demo Company', true],
  ] as const) {
    const replies = {
      data: [
        {
          id: 'search',
          text: '',
          toolCalls: [{ id: 'search_0', name: 'market_search_1', args: { query: company } }],
        },
        {
          id: 'market',
          text: empty
            ? 'Market analysis: empty findings. No fixture evidence; market conclusions are unverifiable.'
            : 'Market analysis: bulletin-lantern describes an invented workshop display. Prices, SEC filings and investment prospects are unverifiable.',
        },
      ],
      trading: {
        id: 'strategies',
        text: `Trading strategies: ${empty ? 'no evidence' : 'insufficient synthetic evidence'} for an actionable recommendation. Conservative long-term paper-trading study only; abstain from trading.\n\n${LEGAL_DISCLAIMER}`,
      },
      execution: {
        id: 'execution',
        text: `Execution plan: no orders, broker, entries or exits. Missing market evidence makes an actionable plan unverifiable. Paper study only.\n\n${LEGAL_DISCLAIMER}`,
      },
      risk: {
        id: 'risk',
        text: `Risk assessment: synthetic evidence cannot establish market, liquidity or counterparty risk. Operational, model and psychological uncertainty remain. A conservative long-term profile calls for abstaining from real trades.\n\n${LEGAL_DISCLAIMER}`,
      },
    };
    for (const [role, reply] of Object.entries(replies))
      scripts[role] = { ...scripts[role], [prompt]: reply };
  }
  const chatModels: Record<string, MockChatModel> = {};
  const providers: Record<string, ModelRouting['providers'][string]> = {};
  const roles: Record<string, ModelRouting['roles'][string]> = {};
  const descriptor = hostModels('mock').providers['mock'];
  if (!descriptor) throw new Error('The mock descriptor is missing.');
  for (const [role, script] of Object.entries(scripts)) {
    chatModels[role] = new MockChatModel(script, { sequence: 'assistant-turns' });
    providers[role] = descriptor;
    roles[`financial.${role}`] = { providers: [role], allow: ['in-browser'], maxTokens: 1500 };
  }
  return { chatModels, routing: { providers, roles } };
}
