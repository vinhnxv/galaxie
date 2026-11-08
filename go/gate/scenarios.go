// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"slices"
	"sort"
	"strings"
	"sync/atomic"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/agent/workflowagents/loopagent"
	"google.golang.org/adk/agent/workflowagents/parallelagent"
	"google.golang.org/adk/agent/workflowagents/sequentialagent"
	"google.golang.org/adk/model"
	"google.golang.org/adk/platform"
	"google.golang.org/adk/runner"
	"google.golang.org/adk/session"
	"google.golang.org/adk/tool"
	"google.golang.org/adk/tool/exitlooptool"
	"google.golang.org/adk/tool/functiontool"
	"google.golang.org/genai"
)

// confirmationCall is the function call ADK emits to ask for a confirmation.
const confirmationCall = "adk_request_confirmation"

// Host is what a scenario needs from outside Go. In the browser it is the JavaScript capability
// bridge; natively it is a fixed Go implementation.
type Host interface {
	// Capability calls a named host function with one integer. The name "hang" never answers
	// until ctx ends.
	Capability(ctx context.Context, name string, value int) (int, error)
}

// Result is the deterministic record of one scenario. The native run records it; the Node and
// browser runs must reproduce it byte for byte.
type Result struct {
	Events []string       `json:"events"`
	Extra  map[string]any `json:"extra,omitempty"`
}

// scenarioNames lists every scenario in run order.
var scenarioNames = []string{
	"plain-text",
	"function-tool",
	"confirmation",
	"long-running",
	"streaming",
	"sequential",
	"parallel",
	"loop",
	"output-schema",
	"transfer",
	"tool-error",
	"model-error",
	"cancel",
	"restore",
}

// step is one scripted model call: the responses it yields in order.
type step []*model.LLMResponse

// scripted is a model.LLM that answers from a fixed script and records what it was asked.
type scripted struct {
	name    string
	steps   []step
	calls   int
	streams []bool
	history []string
	failure error
}

func (m *scripted) Name() string { return m.name }

func (m *scripted) GenerateContent(
	ctx context.Context,
	request *model.LLMRequest,
	stream bool,
) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		if err := ctx.Err(); err != nil {
			yield(nil, err)
			return
		}
		m.streams = append(m.streams, stream)
		for _, content := range request.Contents {
			for _, part := range content.Parts {
				if part.Text != "" {
					m.history = append(m.history, part.Text)
				}
			}
		}
		if m.failure != nil {
			yield(nil, m.failure)
			return
		}
		if m.calls >= len(m.steps) {
			yield(nil, errors.New("the script has no reply left"))
			return
		}
		current := m.steps[m.calls]
		m.calls++
		for _, response := range current {
			if !yield(response, nil) {
				return
			}
		}
	}
}

func say(text string) step {
	return step{{Content: genai.NewContentFromText(text, genai.RoleModel), TurnComplete: true}}
}

func call(name string, arguments map[string]any) step {
	return step{{
		Content: &genai.Content{
			Role:  genai.RoleModel,
			Parts: []*genai.Part{{FunctionCall: &genai.FunctionCall{Name: name, Args: arguments}}},
		},
		TurnComplete: true,
	}}
}

type valueIn struct {
	Value int `json:"value"`
}

type valueOut struct {
	Value int `json:"value"`
}

// deterministic makes identifiers a plain sequence, so native and browser runs produce equal
// events. Parallel sub-agents draw from it on separate goroutines, so the counter is atomic; the
// order of the numbers across them can vary, and recorded results leave the identifiers out.
func deterministic(ctx context.Context) context.Context {
	var next atomic.Int64
	return platform.WithUUIDProvider(ctx, func() string {
		return fmt.Sprintf("uuid-%d", next.Add(1))
	})
}

// describe turns an event into a short, stable line.
func describe(event *session.Event) string {
	fields := []string{event.Author}
	if event.Partial {
		fields = append(fields, "partial")
	}
	if event.Content != nil {
		for _, part := range event.Content.Parts {
			switch {
			case part.FunctionCall != nil:
				fields = append(fields, "call:"+part.FunctionCall.Name)
			case part.FunctionResponse != nil:
				fields = append(fields, "response:"+part.FunctionResponse.Name)
			case part.Text != "":
				fields = append(fields, "text:"+part.Text)
			}
		}
	}
	if event.Actions.Escalate {
		fields = append(fields, "escalate")
	}
	if event.Actions.TransferToAgent != "" {
		fields = append(fields, "transfer:"+event.Actions.TransferToAgent)
	}
	if len(event.LongRunningToolIDs) > 0 {
		fields = append(fields, "long-running")
	}
	return strings.Join(fields, "|")
}

// harness runs agents against one in-memory session service.
type harness struct {
	ctx      context.Context
	service  session.Service
	runner   *runner.Runner
	events   []string
	confirms []string
	longRun  []string
}

func newHarness(ctx context.Context, root agent.Agent) (*harness, error) {
	ctx = deterministic(ctx)
	service := session.InMemoryService()
	r, err := runner.New(runner.Config{AppName: "gate", Agent: root, SessionService: service})
	if err != nil {
		return nil, err
	}
	if _, err := service.Create(ctx, &session.CreateRequest{
		AppName: "gate", UserID: "user", SessionID: "session",
	}); err != nil {
		return nil, err
	}
	return &harness{ctx: ctx, service: service, runner: r, events: []string{}}, nil
}

// turn runs one user message and records the events; it returns the run's error, if any.
func (h *harness) turn(message *genai.Content, streaming bool) error {
	config := agent.RunConfig{}
	if streaming {
		config.StreamingMode = agent.StreamingModeSSE
	}
	for event, err := range h.runner.Run(h.ctx, "user", "session", message, config) {
		if err != nil {
			return err
		}
		h.events = append(h.events, describe(event))
		if event.Content == nil {
			continue
		}
		for _, part := range event.Content.Parts {
			if part.FunctionCall != nil && part.FunctionCall.Name == confirmationCall {
				h.confirms = append(h.confirms, part.FunctionCall.ID)
			}
			if part.FunctionCall != nil && slices.Contains(event.LongRunningToolIDs, part.FunctionCall.ID) {
				h.longRun = append(h.longRun, part.FunctionCall.ID)
			}
		}
	}
	return nil
}

func userText(text string) *genai.Content { return genai.NewContentFromText(text, genai.RoleUser) }

func newLLMAgent(name string, m model.LLM, extra func(*llmagent.Config)) (agent.Agent, error) {
	config := llmagent.Config{
		Name: name, Description: "The " + name + " agent.", Model: m, Instruction: "Answer briefly.",
	}
	if extra != nil {
		extra(&config)
	}
	return llmagent.New(config)
}

func doubler(host Host, configure func(*functiontool.Config)) (tool.Tool, error) {
	config := functiontool.Config{Name: "double", Description: "Doubles a value through the host."}
	if configure != nil {
		configure(&config)
	}
	return functiontool.New(config, func(tc tool.Context, in valueIn) (valueOut, error) {
		out, err := host.Capability(tc, "double", in.Value)
		return valueOut{Value: out}, err
	})
}

// runScenario runs one named scenario and returns its record.
func runScenario(ctx context.Context, host Host, name string) (Result, error) {
	switch name {
	case "plain-text":
		return scenarioPlainText(ctx)
	case "function-tool":
		return scenarioFunctionTool(ctx, host)
	case "confirmation":
		return scenarioConfirmation(ctx, host)
	case "long-running":
		return scenarioLongRunning(ctx)
	case "streaming":
		return scenarioStreaming(ctx)
	case "sequential":
		return scenarioWorkflow(ctx, "sequential")
	case "parallel":
		return scenarioWorkflow(ctx, "parallel")
	case "loop":
		return scenarioLoop(ctx)
	case "output-schema":
		return scenarioOutputSchema(ctx)
	case "transfer":
		return scenarioTransfer(ctx)
	case "tool-error":
		return scenarioToolError(ctx, host)
	case "model-error":
		return scenarioModelError(ctx)
	case "cancel":
		return scenarioCancel(ctx, host)
	case "restore":
		return scenarioRestore(ctx)
	}
	return Result{}, fmt.Errorf("unknown scenario %q", name)
}

func scenarioPlainText(ctx context.Context) (Result, error) {
	m := &scripted{name: "model", steps: []step{say("hello")}}
	root, err := newLLMAgent("root", m, nil)
	if err != nil {
		return Result{}, err
	}
	h, err := newHarness(ctx, root)
	if err != nil {
		return Result{}, err
	}
	err = h.turn(userText("hi"), false)
	return Result{Events: h.events, Extra: map[string]any{"modelCalls": m.calls}}, err
}

func scenarioFunctionTool(ctx context.Context, host Host) (Result, error) {
	m := &scripted{name: "model", steps: []step{call("double", map[string]any{"value": 21}), say("42")}}
	double, err := doubler(host, nil)
	if err != nil {
		return Result{}, err
	}
	root, err := newLLMAgent("root", m, func(c *llmagent.Config) { c.Tools = []tool.Tool{double} })
	if err != nil {
		return Result{}, err
	}
	h, err := newHarness(ctx, root)
	if err != nil {
		return Result{}, err
	}
	err = h.turn(userText("double 21"), false)
	return Result{Events: h.events, Extra: map[string]any{"modelCalls": m.calls}}, err
}

func scenarioConfirmation(ctx context.Context, host Host) (Result, error) {
	m := &scripted{name: "model", steps: []step{call("double", map[string]any{"value": 21}), say("confirmed")}}
	runs := 0
	double, err := functiontool.New(
		functiontool.Config{Name: "double", Description: "Doubles a value.", RequireConfirmation: true},
		func(tc tool.Context, in valueIn) (valueOut, error) {
			runs++
			out, err := host.Capability(tc, "double", in.Value)
			return valueOut{Value: out}, err
		},
	)
	if err != nil {
		return Result{}, err
	}
	root, err := newLLMAgent("root", m, func(c *llmagent.Config) { c.Tools = []tool.Tool{double} })
	if err != nil {
		return Result{}, err
	}
	h, err := newHarness(ctx, root)
	if err != nil {
		return Result{}, err
	}
	if err := h.turn(userText("double 21"), false); err != nil {
		return Result{}, err
	}
	pausedRuns, asks := runs, len(h.confirms)
	if asks != 1 {
		return Result{}, fmt.Errorf("expected one confirmation request, found %d", asks)
	}
	answer := &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{
		FunctionResponse: &genai.FunctionResponse{
			ID: h.confirms[0], Name: confirmationCall, Response: map[string]any{"confirmed": true},
		},
	}}}
	err = h.turn(answer, false)
	return Result{Events: h.events, Extra: map[string]any{
		"asks": asks, "runsWhilePaused": pausedRuns, "runsAfterAnswer": runs, "modelCalls": m.calls,
	}}, err
}

func scenarioLongRunning(ctx context.Context) (Result, error) {
	m := &scripted{name: "model", steps: []step{call("lookup", map[string]any{"value": 7}), say("working on it"), say("looked up")}}
	lookup, err := functiontool.New(
		functiontool.Config{Name: "lookup", Description: "Starts a lookup.", IsLongRunning: true},
		func(_ tool.Context, _ valueIn) (map[string]string, error) {
			return map[string]string{"status": "pending"}, nil
		},
	)
	if err != nil {
		return Result{}, err
	}
	root, err := newLLMAgent("root", m, func(c *llmagent.Config) { c.Tools = []tool.Tool{lookup} })
	if err != nil {
		return Result{}, err
	}
	h, err := newHarness(ctx, root)
	if err != nil {
		return Result{}, err
	}
	if err := h.turn(userText("look up 7"), false); err != nil {
		return Result{}, err
	}
	if len(h.longRun) != 1 {
		return Result{}, fmt.Errorf("expected one long-running call, found %d", len(h.longRun))
	}
	answer := &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{
		FunctionResponse: &genai.FunctionResponse{
			ID: h.longRun[0], Name: "lookup", Response: map[string]any{"value": 49},
		},
	}}}
	err = h.turn(answer, false)
	return Result{Events: h.events, Extra: map[string]any{"pending": len(h.longRun), "modelCalls": m.calls}}, err
}

func scenarioStreaming(ctx context.Context) (Result, error) {
	partial := func(text string) *model.LLMResponse {
		return &model.LLMResponse{Content: genai.NewContentFromText(text, genai.RoleModel), Partial: true}
	}
	final := &model.LLMResponse{
		Content: genai.NewContentFromText("Hello world", genai.RoleModel), TurnComplete: true,
	}
	m := &scripted{name: "model", steps: []step{{partial("Hel"), partial("lo "), final}}}
	root, err := newLLMAgent("root", m, nil)
	if err != nil {
		return Result{}, err
	}
	h, err := newHarness(ctx, root)
	if err != nil {
		return Result{}, err
	}
	err = h.turn(userText("greet"), true)
	return Result{Events: h.events, Extra: map[string]any{"streamFlags": m.streams}}, err
}

func scenarioWorkflow(ctx context.Context, kind string) (Result, error) {
	left := &scripted{name: "left", steps: []step{say("left done")}}
	right := &scripted{name: "right", steps: []step{say("right done")}}
	a, err := newLLMAgent("left", left, nil)
	if err != nil {
		return Result{}, err
	}
	b, err := newLLMAgent("right", right, nil)
	if err != nil {
		return Result{}, err
	}
	config := agent.Config{Name: kind, Description: "A " + kind + " workflow.", SubAgents: []agent.Agent{a, b}}
	var root agent.Agent
	if kind == "sequential" {
		root, err = sequentialagent.New(sequentialagent.Config{AgentConfig: config})
	} else {
		root, err = parallelagent.New(parallelagent.Config{AgentConfig: config})
	}
	if err != nil {
		return Result{}, err
	}
	h, err := newHarness(ctx, root)
	if err != nil {
		return Result{}, err
	}
	err = h.turn(userText("go"), false)
	if kind == "parallel" {
		// Branches interleave in any order, so the record is sorted.
		sort.Strings(h.events)
	}
	return Result{Events: h.events, Extra: map[string]any{"left": left.calls, "right": right.calls}}, err
}

func scenarioLoop(ctx context.Context) (Result, error) {
	exit, err := exitlooptool.New()
	if err != nil {
		return Result{}, err
	}
	m := &scripted{name: "worker", steps: []step{say("pass one"), call("exit_loop", map[string]any{}), say("never")}}
	worker, err := newLLMAgent("worker", m, func(c *llmagent.Config) { c.Tools = []tool.Tool{exit} })
	if err != nil {
		return Result{}, err
	}
	root, err := loopagent.New(loopagent.Config{
		AgentConfig:   agent.Config{Name: "refine", Description: "Refines.", SubAgents: []agent.Agent{worker}},
		MaxIterations: 5,
	})
	if err != nil {
		return Result{}, err
	}
	h, err := newHarness(ctx, root)
	if err != nil {
		return Result{}, err
	}
	err = h.turn(userText("refine"), false)
	return Result{Events: h.events, Extra: map[string]any{"modelCalls": m.calls}}, err
}

func scenarioOutputSchema(ctx context.Context) (Result, error) {
	schema := &genai.Schema{
		Type:       genai.TypeObject,
		Properties: map[string]*genai.Schema{"answer": {Type: genai.TypeString}},
		Required:   []string{"answer"},
	}
	m := &scripted{name: "model", steps: []step{say(`{"answer":"yes"}`)}}
	root, err := newLLMAgent("root", m, func(c *llmagent.Config) { c.OutputSchema = schema })
	if err != nil {
		return Result{}, err
	}
	h, err := newHarness(ctx, root)
	if err != nil {
		return Result{}, err
	}
	err = h.turn(userText("answer"), false)
	return Result{Events: h.events, Extra: map[string]any{"modelCalls": m.calls}}, err
}

func scenarioTransfer(ctx context.Context) (Result, error) {
	helperModel := &scripted{name: "helper", steps: []step{say("helper here")}}
	helper, err := newLLMAgent("helper", helperModel, nil)
	if err != nil {
		return Result{}, err
	}
	rootModel := &scripted{name: "root", steps: []step{call("transfer_to_agent", map[string]any{"agent_name": "helper"})}}
	root, err := newLLMAgent("root", rootModel, func(c *llmagent.Config) { c.SubAgents = []agent.Agent{helper} })
	if err != nil {
		return Result{}, err
	}
	h, err := newHarness(ctx, root)
	if err != nil {
		return Result{}, err
	}
	err = h.turn(userText("route"), false)
	return Result{Events: h.events, Extra: map[string]any{
		"rootCalls": rootModel.calls, "helperCalls": helperModel.calls,
	}}, err
}

func scenarioToolError(ctx context.Context, host Host) (Result, error) {
	m := &scripted{name: "model", steps: []step{call("double", map[string]any{"value": -1}), say("recovered")}}
	double, err := doubler(host, nil)
	if err != nil {
		return Result{}, err
	}
	root, err := newLLMAgent("root", m, func(c *llmagent.Config) { c.Tools = []tool.Tool{double} })
	if err != nil {
		return Result{}, err
	}
	h, err := newHarness(ctx, root)
	if err != nil {
		return Result{}, err
	}
	runErr := h.turn(userText("double -1"), false)
	return Result{Events: h.events, Extra: map[string]any{
		"failed": runErr != nil, "modelCalls": m.calls,
	}}, nil
}

func scenarioModelError(ctx context.Context) (Result, error) {
	m := &scripted{name: "model", failure: errors.New("model unavailable")}
	root, err := newLLMAgent("root", m, nil)
	if err != nil {
		return Result{}, err
	}
	h, err := newHarness(ctx, root)
	if err != nil {
		return Result{}, err
	}
	runErr := h.turn(userText("hi"), false)
	text := ""
	if runErr != nil {
		text = runErr.Error()
	}
	return Result{Events: h.events, Extra: map[string]any{"failed": runErr != nil, "error": text}}, nil
}

func scenarioCancel(ctx context.Context, host Host) (Result, error) {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	m := &scripted{name: "model", steps: []step{call("wait", map[string]any{"value": 1}), say("never")}}
	entered := make(chan struct{})
	wait, err := functiontool.New(
		functiontool.Config{Name: "wait", Description: "Waits for the host forever."},
		func(tc tool.Context, in valueIn) (valueOut, error) {
			close(entered)
			out, err := host.Capability(tc, "hang", in.Value)
			return valueOut{Value: out}, err
		},
	)
	if err != nil {
		return Result{}, err
	}
	root, err := newLLMAgent("root", m, func(c *llmagent.Config) { c.Tools = []tool.Tool{wait} })
	if err != nil {
		return Result{}, err
	}
	h, err := newHarness(runCtx, root)
	if err != nil {
		return Result{}, err
	}
	go func() {
		<-entered
		cancel()
	}()
	runErr := h.turn(userText("wait"), false)
	return Result{Events: h.events, Extra: map[string]any{
		"cancelled": errors.Is(runErr, context.Canceled), "modelCalls": m.calls,
	}}, nil
}

func scenarioRestore(ctx context.Context) (Result, error) {
	first := &scripted{name: "model", steps: []step{say("first answer")}}
	root, err := newLLMAgent("root", first, nil)
	if err != nil {
		return Result{}, err
	}
	h, err := newHarness(ctx, root)
	if err != nil {
		return Result{}, err
	}
	if err := h.turn(userText("first question"), false); err != nil {
		return Result{}, err
	}
	stored, err := h.service.Get(h.ctx, &session.GetRequest{AppName: "gate", UserID: "user", SessionID: "session"})
	if err != nil {
		return Result{}, err
	}
	var records [][]byte
	for event := range stored.Session.Events().All() {
		record, err := json.Marshal(event)
		if err != nil {
			return Result{}, err
		}
		records = append(records, record)
	}
	// A fresh service and a fresh runner receive the saved events, as a restored page would.
	second := &scripted{name: "model", steps: []step{say("second answer")}}
	restoredRoot, err := newLLMAgent("root", second, nil)
	if err != nil {
		return Result{}, err
	}
	restored, err := newHarness(ctx, restoredRoot)
	if err != nil {
		return Result{}, err
	}
	created, err := restored.service.Get(restored.ctx, &session.GetRequest{
		AppName: "gate", UserID: "user", SessionID: "session",
	})
	if err != nil {
		return Result{}, err
	}
	roundTrips := true
	for _, record := range records {
		var event session.Event
		if err := json.Unmarshal(record, &event); err != nil {
			return Result{}, err
		}
		again, err := json.Marshal(&event)
		if err != nil {
			return Result{}, err
		}
		roundTrips = roundTrips && string(again) == string(record)
		if err := restored.service.AppendEvent(restored.ctx, created.Session, &event); err != nil {
			return Result{}, err
		}
	}
	err = restored.turn(userText("second question"), false)
	return Result{Events: restored.events, Extra: map[string]any{
		"restoredRecords": len(records),
		"roundTrips":      roundTrips,
		"sawHistory":      slices.Contains(second.history, "first answer") && slices.Contains(second.history, "first question"),
	}}, err
}
