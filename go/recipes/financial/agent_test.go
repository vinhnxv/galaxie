// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package financial

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

type scriptedPage struct {
	t        *testing.T
	requests []llm.ModelRequest
	searches []llm.CapabilityRequest
}

func (s *scriptedPage) Call(_ context.Context, op string, payload []byte) ([]byte, error) {
	switch op {
	case "model":
		var request llm.ModelRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, err
		}
		s.requests = append(s.requests, request)
		if len(s.requests) == 1 {
			return []byte(`{"content":"","toolCalls":[{"id":"search","type":"function","function":{"name":"market_search_1","arguments":"{\"query\":\"Lantern\"}"}}]}`), nil
		}
		text := map[string]string{
			"financial.data":      "market report",
			"financial.trading":   "strategy report",
			"financial.execution": "execution report",
			"financial.risk":      "risk report\n\n" + LegalDisclaimer,
		}[request.Role]
		if text == "" {
			s.t.Fatalf("unexpected model role %q", request.Role)
		}
		return json.Marshal(map[string]string{"content": text})
	case "capability":
		var request llm.CapabilityRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, err
		}
		s.searches = append(s.searches, request)
		return []byte(`{"items":[],"label":"untrusted-tool-output"}`), nil
	default:
		s.t.Fatalf("unexpected operation %q", op)
		return nil, nil
	}
}

func TestFinancialPipelinePassesFourOutputsThroughState(t *testing.T) {
	page := &scriptedPage{t: t}
	result, err := galaxie.NewStore().Run(context.Background(), page, galaxie.Definition{Build: Build}, galaxie.Input{
		Prompt: "Analyze Lantern. Conservative, long-term, paper trading only.", Conversation: "financial", Persist: true, Stream: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	wantState := map[string]string{
		"market_data_analysis_output":        "market report",
		"proposed_trading_strategies_output": "strategy report",
		"execution_plan_output":              "execution report",
		"final_risk_assessment_output":       "risk report\n\n" + LegalDisclaimer,
	}
	if result.Output != wantState["final_risk_assessment_output"] || result.Pause != nil {
		t.Fatalf("unexpected result: %+v", result)
	}
	var record struct {
		Events []struct {
			Actions struct {
				StateDelta map[string]string `json:"stateDelta"`
			} `json:"actions"`
		} `json:"events"`
	}
	if err := json.Unmarshal(result.Record, &record); err != nil {
		t.Fatal(err)
	}
	state := map[string]string{}
	for _, event := range record.Events {
		for key, value := range event.Actions.StateDelta {
			state[key] = value
		}
	}
	if !reflect.DeepEqual(state, wantState) {
		t.Fatalf("state = %#v, want %#v", state, wantState)
	}
	wantRoles := []string{"financial.data", "financial.data", "financial.trading", "financial.execution", "financial.risk"}
	wantAuthors := []string{"data_analyst_agent", "data_analyst_agent", "trading_analyst_agent", "execution_analyst_agent", "risk_analyst_agent"}
	prompts := []string{DataAnalystPrompt, DataAnalystPrompt, TradingAnalystPrompt, ExecutionAnalystPrompt, RiskAnalystPrompt}
	if len(page.requests) != len(wantRoles) {
		t.Fatalf("model requests = %d, want %d", len(page.requests), len(wantRoles))
	}
	for i, request := range page.requests {
		if request.Role != wantRoles[i] || request.Author != wantAuthors[i] || !request.Options.Stream {
			t.Fatalf("request %d = %+v", i, request)
		}
		instruction := prompts[i]
		for key, value := range wantState {
			instruction = strings.ReplaceAll(instruction, "{"+key+"?}", value)
		}
		if len(request.Messages) == 0 || !strings.HasPrefix(request.Messages[0].Content, instruction) {
			t.Fatalf("request %d did not interpolate its instruction: %+v", i, request.Messages)
		}
		if i < 2 {
			if len(request.Options.Tools) != 1 || request.Options.Tools[0].Function.Name != "market_search_1" {
				t.Fatalf("data analyst tools = %+v", request.Options.Tools)
			}
		} else if len(request.Options.Tools) != 0 {
			t.Fatalf("specialist %d has unexpected tools", i)
		}
	}
	if len(page.searches) != 1 || page.searches[0].Name != "market.search@1" || page.searches[0].Input["query"] != "Lantern" {
		t.Fatalf("searches = %+v", page.searches)
	}
}
