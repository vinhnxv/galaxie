// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie_test

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"sync"
	"testing"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/tool"
	"google.golang.org/genai"

	"galaxie.invalid/galaxie/conformance/cases"
	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

type agentToolGateCaller struct {
	mu       sync.Mutex
	requests []llm.ModelRequest
}

type agentToolFailureCaller struct {
	mu       sync.Mutex
	requests []llm.ModelRequest
	code     string
	twice    bool
	cancel   context.CancelFunc
	limit    int
	late     bool
}

func (c *agentToolFailureCaller) Call(ctx context.Context, op string, payload []byte) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if op != "model" {
		return nil, llm.NewError("unsupported")
	}
	var request llm.ModelRequest
	if err := json.Unmarshal(payload, &request); err != nil {
		return nil, err
	}
	c.requests = append(c.requests, request)
	if c.limit > 0 && len(c.requests) > c.limit {
		return nil, llm.NewError("budget_exceeded")
	}
	if c.late && request.Role == "outer" && len(c.requests) > 2 {
		return nil, llm.NewError("unavailable")
	}
	if request.Role == "inner" {
		if c.cancel != nil {
			c.cancel()
			return nil, llm.NewError("cancelled")
		}
		if c.code != "" {
			return nil, llm.NewError(c.code)
		}
		return []byte(`{"content":"inner answer"}`), nil
	}
	if len(c.requests) == 1 {
		calls := []llm.ToolCall{{ID: "provider", Type: "function", Function: llm.FunctionCall{Name: "inner", Arguments: `{"request":"question"}`}}}
		if c.twice {
			calls = append(calls, llm.ToolCall{ID: "provider", Type: "function", Function: llm.FunctionCall{Name: "inner", Arguments: `{"request":"another"}`}})
		}
		return json.Marshal(llm.ModelReply{ToolCalls: calls})
	}
	return []byte(`{"content":"outer answer"}`), nil
}

func TestAgentToolGateSharedBudgetAndFailedCompletedInnerRollback(t *testing.T) {
	for _, kind := range []string{"plain", "direct"} {
		caller := &agentToolFailureCaller{limit: 1}
		_, err := galaxie.NewStore().Run(context.Background(), caller, galaxie.Definition{Build: cases.AgentToolEntry(kind)}, galaxie.Input{Prompt: "go", Conversation: "c", Persist: true})
		if kind == "plain" && llm.CodeOf(err) != "budget_exceeded" {
			t.Fatalf("wrapper budget error=%v", err)
		}
		if kind == "direct" && err != nil {
			t.Fatalf("outer-direct budget error=%v", err)
		}
	}
	first, err := galaxie.NewStore().Run(context.Background(), &agentToolFailureCaller{}, galaxie.Definition{Build: cases.AgentToolEntry("plain")}, galaxie.Input{Prompt: "go", Conversation: "c", Persist: true})
	if err != nil {
		t.Fatal(err)
	}
	baseline := append([]byte(nil), first.Record...)
	failed := &agentToolFailureCaller{late: true}
	result, err := galaxie.NewStore().Run(context.Background(), failed, galaxie.Definition{Build: cases.AgentToolEntry("plain")}, galaxie.Input{Prompt: "failed", Conversation: "c", Persist: true, Restore: first.Record})
	if llm.CodeOf(err) != "unavailable" || len(result.Record) != 0 || len(failed.requests) != 3 {
		t.Fatalf("error=%v result=%+v requests=%d", err, result, len(failed.requests))
	}
	if string(first.Record) != string(baseline) {
		t.Fatal("failed run mutated stored bytes")
	}
	retry := &agentToolFailureCaller{}
	if _, err := galaxie.NewStore().Run(context.Background(), retry, galaxie.Definition{Build: cases.AgentToolEntry("plain")}, galaxie.Input{Prompt: "retry", Conversation: "c", Persist: true, Restore: first.Record}); err != nil {
		t.Fatal(err)
	}
	failedMessages := failed.requests[0].Messages
	retryMessages := retry.requests[0].Messages
	if !reflect.DeepEqual(failedMessages[:len(failedMessages)-1], retryMessages[:len(retryMessages)-1]) {
		t.Fatalf("retry history=%v failed=%v", retryMessages, failedMessages)
	}
}

func TestAgentToolGateLiveAndRestoredCompletedHistoryParity(t *testing.T) {
	store := galaxie.NewStore()
	definition := galaxie.Definition{Build: cases.AgentToolEntry("plain")}
	first, err := store.Run(context.Background(), &agentToolFailureCaller{}, definition, galaxie.Input{Prompt: "seed", Conversation: "c", Persist: true})
	if err != nil {
		t.Fatal(err)
	}
	liveCaller := &agentToolFailureCaller{}
	live, err := store.Run(context.Background(), liveCaller, definition, galaxie.Input{Prompt: "continue", Conversation: "c", Persist: true})
	if err != nil {
		t.Fatal(err)
	}
	restoredCaller := &agentToolFailureCaller{}
	restored, err := galaxie.NewStore().Run(context.Background(), restoredCaller, definition, galaxie.Input{Prompt: "continue", Conversation: "c", Persist: true, Restore: first.Record})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(liveCaller.requests, restoredCaller.requests) {
		t.Fatalf("live requests=%v restored=%v", liveCaller.requests, restoredCaller.requests)
	}
	var liveRecord, restoredRecord map[string]any
	if err := json.Unmarshal(live.Record, &liveRecord); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(restored.Record, &restoredRecord); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(liveRecord, restoredRecord) {
		t.Fatalf("live=%s restored=%s", live.Record, restored.Record)
	}
	if strings.Contains(liveCaller.requests[0].Messages[len(liveCaller.requests[0].Messages)-1].Content, "seed") {
		t.Fatal("control did not start the expected fresh completed history")
	}
}

func TestAgentToolGateFailuresStopBeforeLaterOuterRequest(t *testing.T) {
	for _, code := range []string{"unavailable", "denied", "budget_exceeded", "cancelled"} {
		t.Run(code, func(t *testing.T) {
			for _, kind := range []string{"plain", "direct"} {
				ctx, cancel := context.WithCancel(context.Background())
				caller := &agentToolFailureCaller{code: code}
				if code == "cancelled" {
					caller.cancel = cancel
				}
				result, err := galaxie.NewStore().Run(ctx, caller, galaxie.Definition{Build: cases.AgentToolEntry(kind)}, galaxie.Input{Prompt: "go", Conversation: "c", Persist: true})
				cancel()
				if llm.CodeOf(err) != code || len(result.Record) != 0 {
					t.Fatalf("%s error=%v record=%s", kind, err, result.Record)
				}
				want := 2
				if kind == "direct" {
					want = 1
				}
				if len(caller.requests) != want {
					t.Fatalf("%s dispatched %d models", kind, len(caller.requests))
				}
			}
		})
	}
	for _, kind := range []string{"event", "direct-event"} {
		caller := &agentToolFailureCaller{}
		_, err := galaxie.NewStore().Run(context.Background(), caller, galaxie.Definition{Build: cases.AgentToolEntry(kind)}, galaxie.Input{Prompt: "go", Conversation: "c", Persist: true})
		if llm.CodeOf(err) != "unavailable" {
			t.Fatalf("%s inner error event=%v", kind, err)
		}
		if len(caller.requests) > 1 {
			t.Fatalf("%s requests=%d", kind, len(caller.requests))
		}
	}
}

func TestAgentToolGateTwoIsolatedCallsAndRestoredIdentifiers(t *testing.T) {
	seen := map[string]bool{}
	var restore []byte
	for turn := 0; turn < 3; turn++ {
		caller := &agentToolFailureCaller{twice: true}
		result, err := galaxie.NewStore().Run(context.Background(), caller, galaxie.Definition{Build: cases.AgentToolEntry("plain")}, galaxie.Input{Prompt: "go", Conversation: "c", Persist: true, Stream: true, Restore: restore})
		if err != nil {
			t.Fatal(err)
		}
		if len(caller.requests) != 4 {
			t.Fatalf("requests=%d", len(caller.requests))
		}
		for _, request := range caller.requests {
			if request.Role == "inner" {
				users := 0
				for _, message := range request.Messages {
					if message.Role == "user" {
						users++
					} else if message.Role != "system" {
						t.Fatalf("inner history=%+v", request)
					}
				}
				if request.Options.Stream || users != 1 {
					t.Fatalf("inner history/stream=%+v", request)
				}
			}
		}
		var record struct {
			Events []struct {
				Author  string `json:"author"`
				Content struct {
					Parts []struct {
						FunctionCall *struct {
							ID string `json:"id"`
						} `json:"functionCall"`
					} `json:"parts"`
				} `json:"content"`
			} `json:"events"`
			Memory llm.MemoryState `json:"memory"`
		}
		if err := json.Unmarshal(result.Record, &record); err != nil {
			t.Fatal(err)
		}
		calls := 0
		for _, event := range record.Events {
			if event.Author == "inner" {
				t.Fatal("inner event persisted")
			}
			for _, part := range event.Content.Parts {
				if call := part.FunctionCall; call != nil {
					calls++
					if seen[call.ID] {
						t.Fatalf("reused call ID %s", call.ID)
					}
					seen[call.ID] = true
					if !strings.HasPrefix(record.Memory.Scopes[call.ID], "adk-go/c/root/") {
						t.Fatalf("outer scope=%v", record.Memory.Scopes)
					}
				}
			}
		}
		if calls != 2 || len(record.Memory.Scopes) != 2 {
			t.Fatalf("calls=%d scopes=%v", calls, record.Memory.Scopes)
		}
		restore = result.Record
	}
}

func TestAgentToolGateStaticRefusalsDispatchNothing(t *testing.T) {
	for _, kind := range []string{"capability", "confirmation", "long-running", "exit", "toolset", "nested", "input-schema", "output-schema", "duplicate", "collision", "foreign"} {
		t.Run(kind, func(t *testing.T) {
			caller := &agentToolFailureCaller{}
			_, err := galaxie.NewStore().Run(context.Background(), caller, galaxie.Definition{Build: cases.AgentToolEntry(kind)}, galaxie.Input{Prompt: "go", Conversation: "c"})
			if llm.CodeOf(err) != "unsupported" || len(caller.requests) != 0 {
				t.Fatalf("error=%v calls=%d", err, len(caller.requests))
			}
		})
	}
}

func (c *agentToolGateCaller) Call(_ context.Context, op string, payload []byte) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if op != "model" {
		return nil, llm.NewError("unsupported")
	}
	var request llm.ModelRequest
	if err := json.Unmarshal(payload, &request); err != nil {
		return nil, err
	}
	c.requests = append(c.requests, request)
	if len(c.requests) == 1 {
		return []byte(`{"content":"","toolCalls":[{"id":"provider","type":"function","function":{"name":"inner","arguments":"{\"request\":\"question\"}"}}]}`), nil
	}
	return json.Marshal(map[string]any{"content": request.Role + " answer"})
}

func agentToolGateEntry(t *testing.T, states *[]map[string]any, outerState *map[string]any) galaxie.Entry {
	t.Helper()
	return func() (agent.Agent, error) {
		inner, err := galaxie.LlmAgent(llmagent.Config{Name: "inner", Description: "Answer one question.", Model: galaxie.Model("inner"), OutputKey: "changed", BeforeAgentCallbacks: []agent.BeforeAgentCallback{func(ctx agent.CallbackContext) (*genai.Content, error) {
			state := map[string]any{}
			for key, value := range ctx.State().All() {
				state[key] = value
			}
			*states = append(*states, state)
			return nil, nil
		}}})
		if err != nil {
			return nil, err
		}
		wrapped, err := galaxie.AgentTool(inner)
		if err != nil {
			return nil, err
		}
		return galaxie.LlmAgent(llmagent.Config{Name: "outer", Model: galaxie.Model("outer"), Tools: []tool.Tool{wrapped}, BeforeAgentCallbacks: []agent.BeforeAgentCallback{func(ctx agent.CallbackContext) (*genai.Content, error) {
			for key, value := range map[string]any{"ordinary": "copied", "temp:input": "temporary", "_adk:private": "hidden"} {
				if err := ctx.State().Set(key, value); err != nil {
					return nil, err
				}
			}
			return nil, nil
		}}, AfterAgentCallbacks: []agent.AfterAgentCallback{func(ctx agent.CallbackContext) (*genai.Content, error) {
			*outerState = map[string]any{}
			for key, value := range ctx.State().All() {
				(*outerState)[key] = value
			}
			return nil, nil
		}}})
	}
}

func TestAgentToolGateNativeDeclarationResultAndStateParity(t *testing.T) {
	native := observeNativeAgentTool(t, false, "", "", "changed")
	if native.err != nil {
		t.Fatal(native.err)
	}
	caller := &agentToolGateCaller{}
	var states []map[string]any
	var outerState map[string]any
	result, err := galaxie.NewStore().Run(context.Background(), caller, galaxie.Definition{Build: agentToolGateEntry(t, &states, &outerState)}, galaxie.Input{Prompt: "go", Conversation: "c", Persist: true})
	if err != nil {
		t.Fatal(err)
	}
	nativeWire, err := llm.RequestToWire("outer", native.requests[0])
	if err != nil {
		t.Fatal(err)
	}
	nativeDeclaration, _ := json.Marshal(nativeWire.Options.Tools)
	candidateDeclaration, _ := json.Marshal(caller.requests[0].Options.Tools)
	if string(candidateDeclaration) != string(nativeDeclaration) {
		t.Fatalf("candidate declaration=%s\nnative declaration=%s", candidateDeclaration, nativeDeclaration)
	}
	if !reflect.DeepEqual(states, native.states) {
		t.Fatalf("candidate copied state=%v native=%v", states, native.states)
	}
	if !reflect.DeepEqual(outerState, native.state) {
		t.Fatalf("candidate forwarded state=%v native=%v", outerState, native.state)
	}
	roles := []string{}
	for _, request := range caller.requests {
		roles = append(roles, request.Role)
	}
	if !reflect.DeepEqual(roles, native.order) {
		t.Fatalf("candidate requests=%v native=%v", roles, native.order)
	}
	if result.Output != "outer answer" {
		t.Fatalf("result=%q", result.Output)
	}
	last := caller.requests[len(caller.requests)-1].Messages
	var response map[string]any
	if err := json.Unmarshal([]byte(last[len(last)-1].Content), &response); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(response, nativeAgentToolResults(native)[0]) {
		t.Fatalf("result=%v native=%v", response, nativeAgentToolResults(native))
	}
}
