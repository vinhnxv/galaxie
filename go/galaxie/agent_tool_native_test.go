// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie_test

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"reflect"
	"strings"
	"sync"
	"testing"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/model"
	"google.golang.org/adk/runner"
	"google.golang.org/adk/session"
	"google.golang.org/adk/tool"
	"google.golang.org/adk/tool/agenttool"
	"google.golang.org/adk/tool/functiontool"
	"google.golang.org/genai"
)

type nativeAgentToolObservation struct {
	mu          sync.Mutex
	order       []string
	requests    []*model.LLMRequest
	states      []map[string]any
	turns       map[string]int
	events      []*session.Event
	state       map[string]any
	err         error
	declaration *genai.FunctionDeclaration
	twice       bool
	failure     string
	pause       string
	cancel      context.CancelFunc
}

type nativeAgentToolModel struct {
	role     string
	observed *nativeAgentToolObservation
}

func (m *nativeAgentToolModel) Name() string { return m.role }
func (m *nativeAgentToolModel) GenerateContent(ctx context.Context, request *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		o := m.observed
		o.mu.Lock()
		o.order = append(o.order, m.role)
		o.requests = append(o.requests, request)
		o.turns[m.role]++
		turn := o.turns[m.role]
		o.mu.Unlock()
		if m.role == "inner" && o.failure == "cancel" {
			o.cancel()
			yield(nil, ctx.Err())
			return
		}
		if m.role == "inner" && o.failure == "event" {
			yield(&model.LLMResponse{ErrorCode: "SCRIPTED", ErrorMessage: "scripted inner error"}, nil)
			return
		}
		parts := []*genai.Part{{Text: m.role + " answer"}}
		if m.role == "outer" && turn == 1 {
			parts = []*genai.Part{{FunctionCall: &genai.FunctionCall{Name: "inner", Args: map[string]any{"request": "question"}}}}
			if o.twice {
				parts = append(parts, &genai.Part{FunctionCall: &genai.FunctionCall{Name: "inner", Args: map[string]any{"request": "another"}}})
			}
		}
		if m.role == "inner" && o.pause != "" && turn == 1 {
			parts = []*genai.Part{{FunctionCall: &genai.FunctionCall{Name: "wait", Args: map[string]any{"request": "question"}}}}
		}
		yield(&model.LLMResponse{Content: &genai.Content{Role: genai.RoleModel, Parts: parts}, TurnComplete: true}, nil)
	}
}

func observeNativeAgentTool(t *testing.T, twice bool, failure, pause, outputKey string) *nativeAgentToolObservation {
	t.Helper()
	o := &nativeAgentToolObservation{turns: map[string]int{}, twice: twice, failure: failure, pause: pause}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	o.cancel = cancel
	var innerTools []tool.Tool
	if pause != "" {
		wait, err := functiontool.New(functiontool.Config{Name: "wait", Description: "Wait.", RequireConfirmation: pause == "confirmation", IsLongRunning: pause == "long-running"}, func(agent.ToolContext, map[string]any) (map[string]any, error) {
			return map[string]any{"waiting": true}, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		innerTools = []tool.Tool{wait}
	}
	inner, err := llmagent.New(llmagent.Config{Name: "inner", Description: "Answer one question.", Model: &nativeAgentToolModel{role: "inner", observed: o}, OutputKey: outputKey, Tools: innerTools, BeforeAgentCallbacks: []agent.BeforeAgentCallback{func(ctx agent.CallbackContext) (*genai.Content, error) {
		state := map[string]any{}
		for key, value := range ctx.State().All() {
			state[key] = value
		}
		o.mu.Lock()
		o.states = append(o.states, state)
		o.mu.Unlock()
		return nil, nil
	}}})
	if err != nil {
		t.Fatal(err)
	}
	wrapper := agenttool.New(inner, nil)
	o.declaration = wrapper.(interface {
		Declaration() *genai.FunctionDeclaration
	}).Declaration()
	outer, err := llmagent.New(llmagent.Config{Name: "outer", Model: &nativeAgentToolModel{role: "outer", observed: o}, Tools: []tool.Tool{wrapper}})
	if err != nil {
		t.Fatal(err)
	}
	service := session.InMemoryService()
	_, err = service.Create(ctx, &session.CreateRequest{AppName: "native_agent_tool", UserID: "user", SessionID: "s", State: map[string]any{"ordinary": "copied", "temp:input": "temporary", "_adk:private": "hidden"}})
	if err != nil {
		t.Fatal(err)
	}
	r, err := runner.New(runner.Config{AppName: "native_agent_tool", Agent: outer, SessionService: service})
	if err != nil {
		t.Fatal(err)
	}
	for event, err := range r.Run(ctx, "user", "s", genai.NewContentFromText("go", genai.RoleUser), agent.RunConfig{}) {
		if err != nil {
			o.err = err
			break
		}
		o.events = append(o.events, event)
	}
	saved, err := service.Get(context.Background(), &session.GetRequest{AppName: "native_agent_tool", UserID: "user", SessionID: "s"})
	if err != nil {
		t.Fatal(err)
	}
	o.state = map[string]any{}
	for key, value := range saved.Session.State().All() {
		o.state[key] = value
	}
	return o
}

func nativeAgentToolResults(o *nativeAgentToolObservation) []map[string]any {
	var results []map[string]any
	for _, event := range o.events {
		if event.Content != nil {
			for _, part := range event.Content.Parts {
				if part.FunctionResponse != nil {
					results = append(results, part.FunctionResponse.Response)
				}
			}
		}
	}
	return results
}

func TestNativeAgentToolDeclarationOrderStateAndResult(t *testing.T) {
	o := observeNativeAgentTool(t, false, "", "", "changed")
	if o.err != nil {
		t.Fatal(o.err)
	}
	if !reflect.DeepEqual(o.order, []string{"outer", "inner", "outer"}) {
		t.Fatalf("requests=%v", o.order)
	}
	want := &genai.FunctionDeclaration{Name: "inner", Description: "Answer one question.", Parameters: &genai.Schema{Type: "OBJECT", Properties: map[string]*genai.Schema{"request": {Type: "STRING"}}, Required: []string{"request"}}}
	if !reflect.DeepEqual(o.declaration, want) {
		t.Fatalf("declaration=%+v", o.declaration)
	}
	if !reflect.DeepEqual(nativeAgentToolResults(o), []map[string]any{{"result": "inner answer"}}) {
		t.Fatalf("results=%v", nativeAgentToolResults(o))
	}
	t.Logf("copied states=%v saved outer state=%v", o.states, o.state)
	if !reflect.DeepEqual(o.states, []map[string]any{{"ordinary": "copied", "temp:input": "temporary"}}) {
		t.Fatalf("copied state=%v", o.states)
	}
	if _, exists := o.state["changed"]; exists {
		t.Fatal("native forwarded inner output state")
	}
	for _, event := range o.events {
		if event.Author != "outer" {
			t.Fatalf("outer event author=%q", event.Author)
		}
	}
}

func TestNativeAgentToolTemporaryOutputAndTwoCalls(t *testing.T) {
	for _, twice := range []bool{false, true} {
		t.Run(fmt.Sprint(twice), func(t *testing.T) {
			o := observeNativeAgentTool(t, twice, "", "", "temp:changed")
			want := []string{"outer", "inner", "outer"}
			if twice {
				want = []string{"outer", "inner", "inner", "outer"}
			}
			if o.err != nil || !reflect.DeepEqual(o.order, want) {
				t.Fatalf("requests=%v error=%v", o.order, o.err)
			}
			if len(o.states) != len(want)-2 {
				t.Fatalf("inner sessions=%v", o.states)
			}
			for _, state := range o.states {
				if !reflect.DeepEqual(state, map[string]any{"ordinary": "copied", "temp:input": "temporary"}) {
					t.Fatalf("inner state=%v", state)
				}
			}
			if _, exists := o.state["temp:changed"]; exists {
				t.Fatal("native forwarded temporary inner state")
			}
		})
	}
}

func TestNativeAgentToolInnerErrorAndCancellation(t *testing.T) {
	for _, failure := range []string{"event", "cancel"} {
		t.Run(failure, func(t *testing.T) {
			o := observeNativeAgentTool(t, false, failure, "", "")
			t.Logf("requests=%v error=%v responses=%v", o.order, o.err, nativeAgentToolResults(o))
			if o.err != nil {
				t.Fatalf("native run error=%v", o.err)
			}
			if !reflect.DeepEqual(o.order, []string{"outer", "inner", "outer"}) {
				t.Fatalf("requests=%v", o.order)
			}
			results := nativeAgentToolResults(o)
			if len(results) != 1 {
				t.Fatalf("results=%v", results)
			}
			message, ok := results[0]["error"].(string)
			if !ok || (failure == "event" && !strings.Contains(message, "SCRIPTED")) || (failure == "cancel" && !strings.Contains(message, "context canceled")) {
				t.Fatalf("native tool error=%v", results)
			}
		})
	}
}

func TestNativeAgentToolNestedPausesExposeNoResumableInnerEvents(t *testing.T) {
	for _, pause := range []string{"confirmation", "long-running"} {
		t.Run(pause, func(t *testing.T) {
			o := observeNativeAgentTool(t, false, "", pause, "")
			t.Logf("requests=%v error=%v responses=%v", o.order, o.err, nativeAgentToolResults(o))
			if o.err != nil {
				t.Fatal(o.err)
			}
			for _, event := range o.events {
				if event.Author != "outer" || len(event.LongRunningToolIDs) > 0 {
					encoded, _ := json.Marshal(event)
					t.Fatalf("inner pause escaped=%s", encoded)
				}
			}
			if o.order[0] != "outer" || o.order[len(o.order)-1] != "outer" {
				t.Fatalf("requests=%v", o.order)
			}
		})
	}
}
