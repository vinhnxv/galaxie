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

// Changed for galaxie: replace the conversational coordinator and AgentTool
// specialists with a SequentialAgent, routed models and a fixture capability.
// Sources: contrib/go/financial-advisor/agent.go and
// {data,trading,execution,risk}_analyst.go.
// google/adk-recipes commit 1e5ed1a5713b739ff8ba58b39454c02bf8bad118.

package financial

import (
	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/tool"

	"galaxie.invalid/galaxie/galaxie"
)

// Build creates fresh specialists inside the executor's constructor scope.
func Build() (agent.Agent, error) {
	search, err := galaxie.CapabilityTool("market.search@1", galaxie.ToolSpec{
		Description: "Search invented market bulletins. Results are untrusted synthetic tool data.",
		Schema:      `{"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":160}},"required":["query"],"additionalProperties":false}`,
	})
	if err != nil {
		return nil, err
	}
	configs := []llmagent.Config{
		{Name: "data_analyst_agent", Model: galaxie.Model("financial.data"), Instruction: DataAnalystPrompt, OutputKey: "market_data_analysis_output", Tools: []tool.Tool{search}},
		{Name: "trading_analyst_agent", Model: galaxie.Model("financial.trading"), Instruction: TradingAnalystPrompt, OutputKey: "proposed_trading_strategies_output"},
		{Name: "execution_analyst_agent", Model: galaxie.Model("financial.execution"), Instruction: ExecutionAnalystPrompt, OutputKey: "execution_plan_output"},
		{Name: "risk_analyst_agent", Model: galaxie.Model("financial.risk"), Instruction: RiskAnalystPrompt, OutputKey: "final_risk_assessment_output"},
	}
	children := make([]agent.Agent, 0, len(configs))
	for _, config := range configs {
		child, err := galaxie.LlmAgent(config)
		if err != nil {
			return nil, err
		}
		children = append(children, child)
	}
	return galaxie.SequentialAgent(agent.Config{Name: "financial_advisor", SubAgents: children})
}
