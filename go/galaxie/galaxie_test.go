// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/tool"

	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

type scripted struct {
	mu         sync.Mutex
	replies    []string
	models     []llm.ModelRequest
	capability func(llm.CapabilityRequest) (string, error)
	calls      []llm.CapabilityRequest
}

func (s *scripted) Call(_ context.Context, op string, payload []byte) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch op {
	case "model":
		var request llm.ModelRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, err
		}
		s.models = append(s.models, request)
		if len(s.replies) == 0 {
			return nil, llm.NewError("unavailable")
		}
		reply := s.replies[0]
		s.replies = s.replies[1:]
		return []byte(reply), nil
	case "capability":
		var request llm.CapabilityRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, err
		}
		s.calls = append(s.calls, request)
		reply, err := s.capability(request)
		return []byte(reply), err
	}
	return nil, llm.NewError("invalid")
}

const doubleSchema = `{"type":"object","properties":{"value":{"type":"integer"}},"required":["value"]}`

func toolCall(name, arguments string) string {
	encoded, _ := json.Marshal(arguments)
	return `{"content":"","toolCalls":[{"id":"p","type":"function","function":{"name":"` + name + `","arguments":` + string(encoded) + `}}]}`
}

func singleAgent() (agent.Agent, error) {
	double, err := galaxie.CapabilityTool("math.double@1", galaxie.ToolSpec{Description: "Double an integer.", Schema: doubleSchema})
	if err != nil {
		return nil, err
	}
	return galaxie.LlmAgent(llmagent.Config{
		Name:        "agent",
		Model:       galaxie.Model("answer"),
		Instruction: "Use the supplied tools and answer briefly.",
		Tools:       []tool.Tool{double},
	})
}

func TestACapabilityRunReturnsTheFinalText(t *testing.T) {
	caller := &scripted{
		replies:    []string{toolCall("math_double_1", `{"value":3}`), `{"content":"The result is 6."}`},
		capability: func(llm.CapabilityRequest) (string, error) { return `{"value":6}`, nil },
	}
	output, err := galaxie.Execute(context.Background(), caller, singleAgent, galaxie.Input{Prompt: "one tool", Conversation: "c"})
	if err != nil {
		t.Fatal(err)
	}
	if output != "The result is 6." {
		t.Fatalf("output = %q", output)
	}
	if len(caller.calls) != 1 || caller.calls[0].Name != "math.double@1" || caller.calls[0].Input["value"] != float64(3) {
		t.Fatalf("calls = %+v", caller.calls)
	}
	if scope := caller.calls[0].EffectScope; !strings.HasPrefix(scope, "adk-go/c/root/1/0") {
		t.Fatalf("scope = %q", scope)
	}
	second := caller.models[1].Messages
	last := second[len(second)-1]
	if last.Role != "tool" || last.Content != `{"value":6}` || last.ToolCallID != "call-1" || second[len(second)-2].ToolCalls[0].ID != "call-1" {
		t.Fatalf("tool message = %+v", last)
	}
	if caller.models[0].Options.Tools[0].Function.Name != "math_double_1" {
		t.Fatalf("tools = %+v", caller.models[0].Options.Tools)
	}
}

func TestADeniedCapabilityIsShownToTheModelAndTheRunContinues(t *testing.T) {
	caller := &scripted{
		replies:    []string{toolCall("math_double_1", `{"value":3}`), `{"content":"It was denied."}`},
		capability: func(llm.CapabilityRequest) (string, error) { return "", llm.NewError("denied") },
	}
	output, err := galaxie.Execute(context.Background(), caller, singleAgent, galaxie.Input{Prompt: "go", Conversation: "c"})
	if err != nil || output != "It was denied." {
		t.Fatalf("output = %q, err = %v", output, err)
	}
	tool := caller.models[1].Messages[len(caller.models[1].Messages)-1]
	if !strings.Contains(tool.Content, "Policy denied the request.") {
		t.Fatalf("tool message = %q", tool.Content)
	}
}

func TestABudgetFailureEndsTheRunAndLaterCallsDoNotDispatch(t *testing.T) {
	caller := &scripted{
		replies:    []string{toolCall("math_double_1", `{"value":3}`), `{"content":"never"}`},
		capability: func(llm.CapabilityRequest) (string, error) { return "", llm.NewError("budget_exceeded") },
	}
	_, err := galaxie.Execute(context.Background(), caller, singleAgent, galaxie.Input{Prompt: "go", Conversation: "c"})
	var failure *llm.Error
	if !errors.As(err, &failure) || failure.Code != "budget_exceeded" {
		t.Fatalf("err = %v", err)
	}
	if len(caller.models) != 1 {
		t.Fatalf("the run asked the model %d times after a fatal capability failure", len(caller.models))
	}
}

func TestAnAgentOutsideTheConstructorsIsRefused(t *testing.T) {
	forged := func() (agent.Agent, error) {
		return agent.New(agent.Config{Name: "forged", Run: nil})
	}
	_, err := galaxie.Execute(context.Background(), &scripted{}, forged, galaxie.Input{Prompt: "go"})
	var failure *llm.Error
	if !errors.As(err, &failure) || failure.Code != "unsupported" {
		t.Fatalf("err = %v", err)
	}
}

func TestAModelOutsideTheConstructorsIsRefused(t *testing.T) {
	foreign := func() (agent.Agent, error) {
		return galaxie.LlmAgent(llmagent.Config{Name: "agent", Model: llm.New("answer")})
	}
	_, err := galaxie.Execute(context.Background(), &scripted{}, foreign, galaxie.Input{Prompt: "go"})
	var failure *llm.Error
	if !errors.As(err, &failure) || failure.Code != "unsupported" {
		t.Fatalf("err = %v", err)
	}
}

func TestAnUnboundedLoopIsRefused(t *testing.T) {
	loop := func() (agent.Agent, error) {
		inner, err := galaxie.LlmAgent(llmagent.Config{Name: "inner", Model: galaxie.Model("answer")})
		if err != nil {
			return nil, err
		}
		return galaxie.LoopAgent(agent.Config{Name: "loop", SubAgents: []agent.Agent{inner}}, 0)
	}
	_, err := galaxie.Execute(context.Background(), &scripted{}, loop, galaxie.Input{Prompt: "go"})
	var failure *llm.Error
	if !errors.As(err, &failure) || failure.Code != "unsupported" {
		t.Fatalf("err = %v", err)
	}
}

func TestSequentialAgentsRunInOrder(t *testing.T) {
	sequence := func() (agent.Agent, error) {
		first, err := galaxie.LlmAgent(llmagent.Config{Name: "first", Model: galaxie.Model("answer"), OutputKey: "a"})
		if err != nil {
			return nil, err
		}
		second, err := galaxie.LlmAgent(llmagent.Config{Name: "second", Model: galaxie.Model("answer")})
		if err != nil {
			return nil, err
		}
		return galaxie.SequentialAgent(agent.Config{Name: "pipeline", SubAgents: []agent.Agent{first, second}})
	}
	caller := &scripted{replies: []string{`{"content":"one"}`, `{"content":"two"}`}}
	output, err := galaxie.Execute(context.Background(), caller, sequence, galaxie.Input{Prompt: "go", Conversation: "c"})
	if err != nil || output != "two" {
		t.Fatalf("output = %q, err = %v", output, err)
	}
}

func TestACancelledContextEndsTheRunCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	caller := &blocking{}
	done := make(chan error, 1)
	go func() {
		_, err := galaxie.Execute(ctx, caller, singleAgent, galaxie.Input{Prompt: "go", Conversation: "c"})
		done <- err
	}()
	caller.waitStarted()
	cancel()
	err := <-done
	var failure *llm.Error
	if !errors.As(err, &failure) || failure.Code != "cancelled" {
		t.Fatalf("err = %v", err)
	}
}

type blocking struct {
	once    sync.Once
	started chan struct{}
}

func (b *blocking) init() { b.once.Do(func() { b.started = make(chan struct{}) }) }
func (b *blocking) waitStarted() {
	b.init()
	<-b.started
}
func (b *blocking) Call(ctx context.Context, _ string, _ []byte) ([]byte, error) {
	b.init()
	select {
	case <-b.started:
	default:
		close(b.started)
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

func twoToolCalls() string {
	call := func(id string) string {
		return `{"id":"` + id + `","type":"function","function":{"name":"math_double_1","arguments":"{\"value\":3}"}}`
	}
	return `{"content":"","toolCalls":[` + call("p1") + `,` + call("p2") + `]}`
}

func TestASecondToolOfTheSameTurnNeverDispatchesAfterAFatalFailure(t *testing.T) {
	caller := &scripted{
		replies:    []string{twoToolCalls(), `{"content":"never"}`},
		capability: func(llm.CapabilityRequest) (string, error) { return "", llm.NewError("budget_exceeded") },
	}
	_, err := galaxie.Execute(context.Background(), caller, singleAgent, galaxie.Input{Prompt: "go", Conversation: "c"})
	var failure *llm.Error
	if !errors.As(err, &failure) || failure.Code != "budget_exceeded" {
		t.Fatalf("err = %v", err)
	}
	if len(caller.calls) != 1 || len(caller.models) != 1 {
		t.Fatalf("dispatched %d capabilities and %d model requests", len(caller.calls), len(caller.models))
	}
}

func TestAParallelAgentRunsItsBranches(t *testing.T) {
	parallel := func() (agent.Agent, error) {
		var branches []agent.Agent
		for _, name := range []string{"left", "right"} {
			branch, err := galaxie.LlmAgent(llmagent.Config{Name: name, Model: galaxie.Model("answer")})
			if err != nil {
				return nil, err
			}
			branches = append(branches, branch)
		}
		return galaxie.ParallelAgent(agent.Config{Name: "fan", SubAgents: branches})
	}
	caller := &scripted{replies: []string{`{"content":"a"}`, `{"content":"a"}`}}
	output, err := galaxie.Execute(context.Background(), caller, parallel, galaxie.Input{Prompt: "go", Conversation: "c"})
	if err != nil || output != "a" || len(caller.models) != 2 {
		t.Fatalf("output = %q, models = %d, err = %v", output, len(caller.models), err)
	}
}

func TestATreeDeeperThanTheLimitIsRefused(t *testing.T) {
	deep := func() (agent.Agent, error) {
		current, err := galaxie.LlmAgent(llmagent.Config{Name: "leaf", Model: galaxie.Model("answer")})
		if err != nil {
			return nil, err
		}
		for level := 0; level < 20; level++ {
			current, err = galaxie.SequentialAgent(agent.Config{Name: "level" + string(rune('a'+level)), SubAgents: []agent.Agent{current}})
			if err != nil {
				return nil, err
			}
		}
		return current, nil
	}
	_, err := galaxie.Execute(context.Background(), &scripted{}, deep, galaxie.Input{Prompt: "go"})
	var failure *llm.Error
	if !errors.As(err, &failure) || failure.Code != "unsupported" {
		t.Fatalf("err = %v", err)
	}
}

func TestAStreamingRunAsksThePageToStreamForEachAgentTurn(t *testing.T) {
	sequence := func() (agent.Agent, error) {
		first, err := galaxie.LlmAgent(llmagent.Config{Name: "first", Model: galaxie.Model("answer"), OutputKey: "a"})
		if err != nil {
			return nil, err
		}
		second, err := galaxie.LlmAgent(llmagent.Config{Name: "second", Model: galaxie.Model("answer")})
		if err != nil {
			return nil, err
		}
		return galaxie.SequentialAgent(agent.Config{Name: "pipeline", SubAgents: []agent.Agent{first, second}})
	}
	caller := &scripted{replies: []string{`{"content":"one"}`, `{"content":"two"}`}}
	output, err := galaxie.Execute(context.Background(), caller, sequence, galaxie.Input{Prompt: "go", Conversation: "c", Stream: true})
	if err != nil || output != "two" {
		t.Fatalf("output = %q, err = %v", output, err)
	}
	if len(caller.models) != 2 {
		t.Fatalf("model requests = %d", len(caller.models))
	}
	for position, author := range []string{"first", "second"} {
		options := caller.models[position].Options
		if !options.Stream || caller.models[position].Author != author {
			t.Fatalf("request %d = %+v", position, caller.models[position])
		}
	}
}

func TestAStreamingRunStillRunsToolsAndEndsOnTheFinalText(t *testing.T) {
	caller := &scripted{
		replies:    []string{toolCall("math_double_1", `{"value":3}`), `{"content":"The result is 6."}`},
		capability: func(llm.CapabilityRequest) (string, error) { return `{"value":6}`, nil },
	}
	output, err := galaxie.Execute(context.Background(), caller, singleAgent, galaxie.Input{Prompt: "go", Conversation: "c", Stream: true})
	if err != nil || output != "The result is 6." {
		t.Fatalf("output = %q, err = %v", output, err)
	}
	if len(caller.calls) != 1 || len(caller.models) != 2 {
		t.Fatalf("calls = %d, model requests = %d", len(caller.calls), len(caller.models))
	}
}

func TestAFailureWhileStreamingEndsTheRunWithItsCode(t *testing.T) {
	caller := &scripted{replies: nil}
	_, err := galaxie.Execute(context.Background(), caller, singleAgent, galaxie.Input{Prompt: "go", Conversation: "c", Stream: true})
	var failure *llm.Error
	if !errors.As(err, &failure) || failure.Code != "unavailable" {
		t.Fatalf("err = %v", err)
	}
}
