// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie_test

import (
	"context"
	"encoding/json"
	"iter"
	"reflect"
	"strings"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/model"
	"google.golang.org/adk/runner"
	"google.golang.org/adk/session"
	"google.golang.org/adk/tool"
	"google.golang.org/adk/tool/functiontool"
	"google.golang.org/adk/tool/geminitool"
	"google.golang.org/genai"

	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

// M-go ALTERNATIVE: native Config.Model has no string form, but AL-M's explicit
// Model helper matches the native foreign scripted model under the same script.
// N-go REFUSED: GN1 fails carriage (the converter rejects provider config).
// X-go/L-go REFUSED: native Config has no executor/planner field. Acceptance
// gates for those absent shapes are not applicable; geminitool code is refused.
type shapeNative struct {
	withTool bool
	turns    int
	configs  []*genai.GenerateContentConfig
	wires    []llm.ModelRequest
}

func (*shapeNative) Name() string { return "gemini-2.5-flash" }
func (m *shapeNative) GenerateContent(_ context.Context, request *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		encoded, _ := json.Marshal(request.Config)
		var config genai.GenerateContentConfig
		if err := json.Unmarshal(encoded, &config); err != nil {
			yield(nil, err)
			return
		}
		m.configs = append(m.configs, &config)
		if wire, err := llm.RequestToWire("answer", request); err == nil {
			m.wires = append(m.wires, wire)
		}
		m.turns++
		part := &genai.Part{Text: "done"}
		if m.withTool && m.turns == 1 {
			part = &genai.Part{FunctionCall: &genai.FunctionCall{Name: "math_double_1", Args: map[string]any{"value": 3}}}
		}
		yield(&model.LLMResponse{Content: &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{part}}, TurnComplete: true}, nil)
	}
}

type shapeToolset struct {
	fixed []tool.Tool
	calls int
}

func (*shapeToolset) Name() string { return "fixed" }
func (s *shapeToolset) Tools(agent.ReadonlyContext) ([]tool.Tool, error) {
	s.calls++
	return append([]tool.Tool(nil), s.fixed...), nil
}

func shapeNativeRun(t *testing.T, root agent.Agent) string {
	t.Helper()
	ctx := context.Background()
	service := session.InMemoryService()
	if _, err := service.Create(ctx, &session.CreateRequest{AppName: "shapes", UserID: "user", SessionID: "s"}); err != nil {
		t.Fatal(err)
	}
	r, err := runner.New(runner.Config{AppName: "shapes", Agent: root, SessionService: service})
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	for event, err := range r.Run(ctx, "user", "s", genai.NewContentFromText("question", genai.RoleUser), agent.RunConfig{}) {
		if err != nil {
			t.Fatal(err)
		}
		if event.IsFinalResponse() && event.Content != nil {
			for _, part := range event.Content.Parts {
				if !part.Thought {
					output.WriteString(part.Text)
				}
			}
		}
	}
	return output.String()
}

func TestModelToolsetForeignAndBuiltinShapesRefuseWithoutRequests(t *testing.T) {
	foreign := &shapeNative{}
	set := &shapeToolset{}
	entries := map[string]func(*llmagent.Config){
		"foreign-model": func(c *llmagent.Config) { c.Model = foreign },
		"real-toolset":  func(c *llmagent.Config) { c.Toolsets = []tool.Toolset{set} },
		"search":        func(c *llmagent.Config) { c.Tools = []tool.Tool{geminitool.GoogleSearch{}} },
	}
	for name, value := range map[string]*genai.Tool{
		"url": {URLContext: &genai.URLContext{}}, "retrieval": {Retrieval: &genai.Retrieval{}},
		"maps": {GoogleMaps: &genai.GoogleMaps{}}, "enterprise": {EnterpriseWebSearch: &genai.EnterpriseWebSearch{}},
		"code": {CodeExecution: &genai.ToolCodeExecution{}},
	} {
		entries[name] = func(c *llmagent.Config) { c.Tools = []tool.Tool{geminitool.New(name, "Provider tool.", value)} }
	}
	for name, configure := range entries {
		t.Run(name, func(t *testing.T) {
			caller := &scripted{}
			_, err := galaxie.Execute(context.Background(), caller, func() (agent.Agent, error) {
				config := llmagent.Config{Name: "root", Model: galaxie.Model("answer")}
				configure(&config)
				return galaxie.LlmAgent(config)
			}, galaxie.Input{Prompt: "question", Conversation: "s"})
			assertCode(t, err, "unsupported")
			if len(caller.models) != 0 || len(caller.calls) != 0 || foreign.turns != 0 || set.calls != 0 {
				t.Fatal("refused shape dispatched work")
			}
		})
	}
}

func TestModelHelperAlternativeMatchesTheNativeUnchangedScript(t *testing.T) {
	native := &shapeNative{}
	root, err := llmagent.New(llmagent.Config{Name: "root", Model: native})
	if err != nil {
		t.Fatal(err)
	}
	want := shapeNativeRun(t, root)
	caller := &scripted{replies: []string{reply("done")}}
	got, err := galaxie.Execute(context.Background(), caller, func() (agent.Agent, error) {
		return galaxie.LlmAgent(llmagent.Config{Name: "root", Model: galaxie.Model("answer")})
	}, galaxie.Input{Prompt: "question", Conversation: "s"})
	if err != nil || got != want || got != "done" {
		t.Fatalf("output=%q native=%q err=%v", got, want, err)
	}
	if len(caller.models) != 1 || caller.models[0].Role != "answer" || len(caller.calls) != 0 {
		t.Fatal("explicit helper did not use the one-reply script")
	}
}

func TestModelToolsetConfigSourceAbsenceAndProviderCarriage(t *testing.T) {
	config := reflect.TypeFor[llmagent.Config]()
	field, _ := config.FieldByName("Model")
	if field.Type.Kind() != reflect.Interface || reflect.TypeFor[string]().AssignableTo(field.Type) {
		t.Fatal("native string-model premise changed")
	}
	for i := 0; i < config.NumField(); i++ {
		name := strings.ToLower(config.Field(i).Name)
		if strings.Contains(name, "planner") || strings.Contains(name, "executor") {
			t.Fatal("native planner/executor surface changed")
		}
	}
	if _, ok := reflect.TypeFor[tool.Toolset]().MethodByName("Close"); ok {
		t.Fatal("toolset lifecycle premise changed")
	}
	for _, provider := range []*genai.Tool{{GoogleSearch: &genai.GoogleSearch{}}, {CodeExecution: &genai.ToolCodeExecution{}}} {
		_, err := llm.RequestToWire("answer", &model.LLMRequest{Config: &genai.GenerateContentConfig{Tools: []*genai.Tool{provider}}})
		assertCode(t, err, "unsupported")
	}
}

func TestNativeToolsetAndFlatCapabilityListUseTheSameScriptAndSchema(t *testing.T) {
	var schema jsonschema.Schema
	if err := json.Unmarshal([]byte(doubleSchema), &schema); err != nil {
		t.Fatal(err)
	}
	calls := 0
	nativeTool, err := functiontool.New(functiontool.Config{Name: "math_double_1", Description: "Double an integer.", InputSchema: &schema}, func(_ tool.Context, args map[string]any) (map[string]any, error) {
		calls++
		return map[string]any{"value": 6}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	set := &shapeToolset{fixed: []tool.Tool{nativeTool}}
	native := &shapeNative{withTool: true}
	root, err := llmagent.New(llmagent.Config{Name: "agent", Model: native, Toolsets: []tool.Toolset{set}})
	if err != nil {
		t.Fatal(err)
	}
	want := shapeNativeRun(t, root)
	caller := &scripted{replies: []string{toolCall("math_double_1", `{"value":3}`), reply("done")}, capability: func(llm.CapabilityRequest) (string, error) { return `{"value":6}`, nil }}
	got, err := galaxie.Execute(context.Background(), caller, singleAgent, galaxie.Input{Prompt: "question", Conversation: "s"})
	if err != nil || got != want || got != "done" || calls != 1 || len(caller.calls) != 1 || set.calls < 2 {
		t.Fatalf("native=%q output=%q calls=%d expansions=%d err=%v", want, got, calls, set.calls, err)
	}
	if !reflect.DeepEqual(native.wires[0].Options.Tools, caller.models[0].Options.Tools) {
		t.Fatalf("native tools=%+v routed=%+v", native.wires[0].Options.Tools, caller.models[0].Options.Tools)
	}
	if caller.calls[0].EffectScope != "adk-go/s/root/1/0" {
		t.Fatalf("scope=%q", caller.calls[0].EffectScope)
	}
}

func TestNativeBuiltinToolsOnlyContributeProviderConfiguration(t *testing.T) {
	for name, builtin := range map[string]tool.Tool{"search": geminitool.GoogleSearch{}, "code": geminitool.New("code", "Code.", &genai.Tool{CodeExecution: &genai.ToolCodeExecution{}})} {
		t.Run(name, func(t *testing.T) {
			native := &shapeNative{}
			root, err := llmagent.New(llmagent.Config{Name: "root", Model: native, Tools: []tool.Tool{builtin}})
			if err != nil {
				t.Fatal(err)
			}
			if got := shapeNativeRun(t, root); got != "done" || native.turns != 1 || len(native.configs[0].Tools) != 1 || len(native.wires) != 0 {
				t.Fatalf("provider-only native run=%q", got)
			}
		})
	}
}
