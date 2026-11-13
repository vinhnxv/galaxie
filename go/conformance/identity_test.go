// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package conformance_test

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"os"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/agent/workflowagents/loopagent"
	"google.golang.org/adk/agent/workflowagents/parallelagent"
	"google.golang.org/adk/agent/workflowagents/sequentialagent"
	"google.golang.org/adk/model"
	"google.golang.org/adk/runner"
	"google.golang.org/adk/session"
	"google.golang.org/adk/tool"
	"google.golang.org/adk/tool/functiontool"
	"google.golang.org/adk/tool/toolconfirmation"
	"google.golang.org/genai"

	"galaxie.invalid/galaxie/conformance/cases"
	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

type identityOracle struct {
	Authors     []string `json:"authors"`
	TextAuthors []string `json:"textAuthors"`
}

// identityModel translates the new test scripts directly into native ADK responses. It does not
// use the shipped bridge mapper, so the native identity oracle is independent of that mapper.
type identityModel struct {
	mu      sync.Mutex
	replies []json.RawMessage
	served  int
	bodies  int
}

func (*identityModel) Name() string { return "scripted-identity" }

func (m *identityModel) GenerateContent(_ context.Context, _ *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		m.mu.Lock()
		if m.served >= len(m.replies) {
			m.mu.Unlock()
			yield(nil, fmt.Errorf("no scripted identity reply remains"))
			return
		}
		raw := m.replies[m.served]
		m.served++
		m.mu.Unlock()
		var reply struct {
			Content   string `json:"content"`
			ToolCalls []struct {
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"toolCalls"`
		}
		if err := json.Unmarshal(raw, &reply); err != nil {
			yield(nil, err)
			return
		}
		parts := []*genai.Part{}
		if reply.Content != "" {
			parts = append(parts, &genai.Part{Text: reply.Content})
		}
		for _, call := range reply.ToolCalls {
			var args map[string]any
			if err := json.Unmarshal([]byte(call.Function.Arguments), &args); err != nil {
				yield(nil, err)
				return
			}
			parts = append(parts, &genai.Part{FunctionCall: &genai.FunctionCall{ID: call.ID, Name: call.Function.Name, Args: args}})
		}
		yield(&model.LLMResponse{Content: &genai.Content{Role: genai.RoleModel, Parts: parts}, TurnComplete: true}, nil)
	}
}

// identityNativeTree deliberately uses native constructors, independently of IdentityDefinitions.
func identityNativeTree(t *testing.T, shape string, m *identityModel) agent.Agent {
	t.Helper()
	must := func(created agent.Agent, err error) agent.Agent {
		if err != nil {
			t.Fatal(err)
		}
		return created
	}
	leaf := func(name string, children ...agent.Agent) agent.Agent {
		return must(llmagent.New(llmagent.Config{Name: name, Model: m, SubAgents: children}))
	}
	sequence := func(name string, children ...agent.Agent) agent.Agent {
		return must(sequentialagent.New(sequentialagent.Config{AgentConfig: agent.Config{Name: name, SubAgents: children}}))
	}
	switch shape {
	case "identity-loop-nested":
		loop := must(loopagent.New(loopagent.Config{AgentConfig: agent.Config{Name: "loop", SubAgents: []agent.Agent{leaf("worker")}}, MaxIterations: 2}))
		return sequence("tree", loop)
	case "identity-sequence-in-sequence":
		return sequence("tree", leaf("first"), sequence("inner", leaf("mid"), leaf("deep")))
	case "identity-transfer-below-nested":
		return sequence("tree", leaf("first"), sequence("inner", leaf("mid"), leaf("router", leaf("helper"))))
	case "identity-chain-16":
		entry := leaf("leaf16")
		for level := 15; level >= 1; level-- {
			entry = sequence(fmt.Sprintf("level%d", level), leaf(fmt.Sprintf("leaf%d", level)), entry)
		}
		return entry
	case "identity-parallel-nested":
		return must(parallelagent.New(parallelagent.Config{AgentConfig: agent.Config{Name: "tree", SubAgents: []agent.Agent{sequence("sequence", leaf("a"), leaf("b")), leaf("c")}}}))
	case "identity-pause-nested-last":
		double, err := functiontool.New(functiontool.Config{Name: "math_double_1", Description: "Double an integer.", RequireConfirmation: true}, func(_ agent.ToolContext, args map[string]any) (map[string]any, error) {
			m.bodies++
			return map[string]any{"value": args["value"].(float64) * 2}, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		deep := must(llmagent.New(llmagent.Config{Name: "deep", Model: m, Tools: []tool.Tool{double}}))
		return sequence("tree", leaf("first"), sequence("inner", leaf("mid"), deep))
	default:
		t.Fatalf("unknown identity shape %q", shape)
		return nil
	}
}

func identityRead[T any](t *testing.T, name string) T {
	t.Helper()
	raw, err := os.ReadFile("../../tests/conformance/cases-adk-go/" + name)
	if err != nil {
		t.Fatal(err)
	}
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func identityNativeRun(t *testing.T, name string, s script) identityOracle {
	t.Helper()
	m := &identityModel{replies: s.Replies}
	ctx := context.Background()
	service := session.InMemoryService()
	if _, err := service.Create(ctx, &session.CreateRequest{AppName: "identity", UserID: "user", SessionID: "session"}); err != nil {
		t.Fatal(err)
	}
	r, err := runner.New(runner.Config{AppName: "identity", Agent: identityNativeTree(t, name, m), SessionService: service})
	if err != nil {
		t.Fatal(err)
	}
	observed := identityOracle{Authors: []string{}, TextAuthors: []string{}}
	var gate *genai.FunctionCall
	consume := func(input *genai.Content) {
		for event, err := range r.Run(ctx, "user", "session", input, agent.RunConfig{}) {
			if err != nil {
				t.Fatal(err)
			}
			if event.Content == nil || event.Content.Role != genai.RoleModel {
				continue
			}
			observed.Authors = append(observed.Authors, event.Author+"|"+event.Branch)
			text := false
			for _, part := range event.Content.Parts {
				text = text || part.Text != ""
				if call := part.FunctionCall; call != nil && call.Name == toolconfirmation.FunctionCallName {
					if gate != nil || event.Author != "deep" {
						t.Fatalf("unexpected native confirmation: %+v", event)
					}
					gate = call
				}
			}
			if text {
				observed.TextAuthors = append(observed.TextAuthors, event.Author)
			}
			if gate != nil {
				break
			}
		}
	}
	consume(genai.NewContentFromText(s.Prompt, genai.RoleUser))
	if name == "identity-pause-nested-last" {
		if gate == nil || m.bodies != 0 || m.served != 3 {
			t.Fatalf("native pause: gate=%+v tool bodies=%d model calls=%d", gate, m.bodies, m.served)
		}
		answer := &genai.Part{FunctionResponse: &genai.FunctionResponse{ID: gate.ID, Name: gate.Name, Response: map[string]any{"confirmed": true}}}
		gate = nil
		consume(&genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{answer}})
		if gate != nil || m.bodies != 1 {
			t.Fatalf("native resume: gate=%+v tool bodies=%d", gate, m.bodies)
		}
	} else if gate != nil {
		t.Fatal("an identity-only shape unexpectedly paused")
	}
	if m.served != len(m.replies) {
		t.Fatalf("native model consumed %d replies, want %d", m.served, len(m.replies))
	}
	slices.Sort(observed.Authors)
	if s.Unordered {
		slices.Sort(observed.TextAuthors)
	}
	return observed
}

func TestNativeIdentityOracle(t *testing.T) {
	scripts := identityRead[map[string]script](t, "identity-scripts.json")
	oracles := identityRead[map[string]identityOracle](t, "identity-oracle.json")
	if len(scripts) != 6 || len(oracles) != len(scripts) {
		t.Fatalf("identity script/oracle counts: %d/%d", len(scripts), len(oracles))
	}
	for name, s := range scripts {
		t.Run(name, func(t *testing.T) {
			observed := identityNativeRun(t, name, s)
			t.Logf("native identity %s: %s", name, indent(t, observed))
			if !reflect.DeepEqual(observed, oracles[name]) {
				t.Fatalf("native identity differs from reviewed oracle\nwant: %s\ngot: %s", indent(t, oracles[name]), indent(t, observed))
			}
		})
	}
	if _, exists := reflect.TypeFor[session.Event]().FieldByName("NodeInfo"); exists {
		t.Fatal("native node-path premise changed")
	}
	for _, field := range []string{"Path", "Branch", "Tree"} {
		if _, exists := reflect.TypeFor[llm.ModelRequest]().FieldByName(field); exists {
			t.Fatalf("the bridge now carries %s", field)
		}
	}
}

func TestIdentityDefinitionsAreDisjoint(t *testing.T) {
	definitions := cases.Definitions()
	identities := cases.IdentityDefinitions()
	scripts := identityRead[map[string]script](t, "identity-scripts.json")
	if len(identities) != len(scripts) {
		t.Fatalf("identity definitions/scripts differ: %d/%d", len(identities), len(scripts))
	}
	for name := range identities {
		if _, exists := definitions[name]; exists {
			t.Fatalf("identity definition shadows existing entry %q", name)
		}
		if scripts[name].Entry != name || !scripts[name].Stream {
			t.Fatalf("identity script %q must name its entry and stream", name)
		}
	}
}

func TestIdentityNestedPauseMatchesExpectedTranscript(t *testing.T) {
	type pauseTranscript struct {
		Pauses       []map[string]any  `json:"pauses"`
		Capabilities []json.RawMessage `json:"capabilities"`
		Output       string            `json:"output"`
		Error        *failure          `json:"error"`
	}
	oracle := identityRead[map[string]struct {
		ExpectedPause pauseTranscript `json:"expectedPause"`
	}](t, "identity-oracle.json")["identity-pause-nested-last"].ExpectedPause
	s := identityRead[map[string]script](t, "identity-scripts.json")["identity-pause-nested-last"]
	for _, persist := range []bool{false, true} {
		t.Run(fmt.Sprintf("persist=%v", persist), func(t *testing.T) {
			page := &recorder{script: s, out: transcript{
				Requests: []json.RawMessage{}, Responses: []json.RawMessage{}, Capabilities: []json.RawMessage{},
			}}
			output, err := drive(t, page, cases.IdentityDefinitions()[s.Entry], s, persist)
			actual := pauseTranscript{Pauses: page.out.Pauses, Capabilities: page.out.Capabilities, Output: output}
			if err != nil {
				actual.Error = &failure{Code: llm.CodeOf(err)}
			}
			if string(normalize(t, indent(t, actual))) != string(normalize(t, indent(t, oracle))) {
				t.Fatalf("nested pause differs from expected transcript\nwant: %s\ngot: %s", indent(t, oracle), indent(t, actual))
			}
		})
	}
}

func identityRefusalTree(t *testing.T, shape string, native bool) agent.Agent {
	t.Helper()
	must := func(created agent.Agent, err error) agent.Agent {
		if err != nil {
			t.Fatal(err)
		}
		return created
	}
	leaf := func(name string) agent.Agent {
		if native {
			return must(llmagent.New(llmagent.Config{Name: name, Model: &identityModel{}}))
		}
		return must(galaxie.LlmAgent(llmagent.Config{Name: name, Model: galaxie.Model("answer")}))
	}
	sequence := func(name string, children ...agent.Agent) agent.Agent {
		config := agent.Config{Name: name, SubAgents: children}
		if native {
			return must(sequentialagent.New(sequentialagent.Config{AgentConfig: config}))
		}
		return must(galaxie.SequentialAgent(config))
	}
	switch shape {
	case "duplicate-leaves":
		return sequence("tree", sequence("first", leaf("worker")), sequence("second", leaf("worker")))
	case "root-descendant":
		return sequence("tree", sequence("inner", leaf("tree")))
	case "shared-instance":
		shared := leaf("worker")
		return sequence("tree", sequence("first", shared), sequence("second", shared))
	default:
		t.Fatalf("unknown refusal shape %q", shape)
		return nil
	}
}

type identityRefusalCaller struct{ authors []string }

func (c *identityRefusalCaller) Call(_ context.Context, op string, payload []byte) ([]byte, error) {
	if op == "model" {
		var request llm.ModelRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, err
		}
		c.authors = append(c.authors, request.Author)
	}
	return nil, llm.NewError("unavailable")
}

func TestIdentityConstructionRefusals(t *testing.T) {
	for _, shape := range []string{"duplicate-leaves", "root-descendant", "shared-instance"} {
		t.Run(shape, func(t *testing.T) {
			_, err := runner.New(runner.Config{AppName: "identity", Agent: identityRefusalTree(t, shape, true), SessionService: session.InMemoryService()})
			message := "agent names must be unique"
			if shape == "shared-instance" {
				message = `"worker" agent cannot have >1 parents, found: "first", "second"`
			}
			if err == nil || !strings.Contains(err.Error(), message) {
				t.Fatalf("native construction error = %v, want %q", err, message)
			}
			caller := &identityRefusalCaller{}
			entry := func() (agent.Agent, error) { return identityRefusalTree(t, shape, false), nil }
			_, err = galaxie.Execute(context.Background(), caller, entry, galaxie.Input{Prompt: "go", Conversation: "identity", Stream: true})
			if llm.CodeOf(err) != "unsupported" || len(caller.authors) != 0 {
				t.Fatalf("Galaxie construction result = %v, authors = %v", err, caller.authors)
			}
		})
	}
}
