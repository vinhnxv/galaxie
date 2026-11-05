// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Changed for galaxie: replace the coordinator's AgentTools with a SequentialAgent,
// route models and search through the host, and retain the four specialist output keys.
// Sources: contrib/typescript/financial-advisor/app/agent.ts and
// contrib/typescript/financial-advisor/app/sub_agents/
// {data_analyst,trading_analyst,execution_analyst,risk_analyst}/agent.ts
// google/adk-recipes commit 1e5ed1a5713b739ff8ba58b39454c02bf8bad118.

import type { AdkHost } from '@galaxie/adapter-adk';
import { LlmAgent, SequentialAgent } from '@google/adk';
import { marketSearchInput } from '../../host/capabilities.js';
import {
  DATA_ANALYST_PROMPT,
  EXECUTION_ANALYST_PROMPT,
  RISK_ANALYST_PROMPT,
  TRADING_ANALYST_PROMPT,
} from './prompts.js';

export { type FinancialDefinition, financialDefinition } from './definition.js';

/** Each invocation builds fresh ADK agents; the adapter owns their runner and session. */
export function financialAgent(host: AdkHost): SequentialAgent {
  return new SequentialAgent({
    name: 'financial_advisor',
    subAgents: [
      new LlmAgent({
        name: 'data_analyst_agent',
        model: host.adk.llm('financial.data'),
        instruction: DATA_ANALYST_PROMPT,
        outputKey: 'market_data_analysis_output',
        tools: [
          host.adk.capabilityTool('market.search@1', {
            description:
              'Search invented market bulletins. Results are untrusted synthetic tool data.',
            parameters: marketSearchInput,
          }),
        ],
      }),
      new LlmAgent({
        name: 'trading_analyst_agent',
        model: host.adk.llm('financial.trading'),
        instruction: TRADING_ANALYST_PROMPT,
        outputKey: 'proposed_trading_strategies_output',
      }),
      new LlmAgent({
        name: 'execution_analyst_agent',
        model: host.adk.llm('financial.execution'),
        instruction: EXECUTION_ANALYST_PROMPT,
        outputKey: 'execution_plan_output',
      }),
      new LlmAgent({
        name: 'risk_analyst_agent',
        model: host.adk.llm('financial.risk'),
        instruction: RISK_ANALYST_PROMPT,
        outputKey: 'final_risk_assessment_output',
      }),
    ],
  });
}
