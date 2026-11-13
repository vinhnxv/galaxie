// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie_test

import (
	"context"
	"reflect"
	"testing"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/tool"

	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

// guide:begin model-go
func buildGuideModel() (agent.Agent, error) {
	return galaxie.LlmAgent(llmagent.Config{
		Name: "root", Model: galaxie.Model("answer"),
	})
}

// guide:end model-go

// guide:begin toolset-go
func buildGuideToolset() (agent.Agent, error) {
	const schema = `{"type":"object","properties":{"value":{"type":"integer"}},"required":["value"]}`
	var tools []tool.Tool
	for _, name := range []string{"flat@1", "math.double@1", "last@1"} {
		created, err := galaxie.CapabilityTool(name, galaxie.ToolSpec{
			Description: "Double an integer.", Schema: schema,
		})
		if err != nil {
			return nil, err
		}
		tools = append(tools, created)
	}
	set, err := galaxie.Toolset(tools[1:]...)
	if err != nil {
		return nil, err
	}
	return galaxie.LlmAgent(llmagent.Config{
		Name: "root", Model: galaxie.Model("answer"),
		Tools: tools[:1], Toolsets: []tool.Toolset{set},
	})
}

// guide:end toolset-go

func TestAuthorGuideModelRoutesToTheDeclaredRole(t *testing.T) {
	caller := &scripted{replies: []string{reply("done")}}
	output, err := galaxie.Execute(context.Background(), caller, buildGuideModel, galaxie.Input{Prompt: "question", Conversation: "s"})
	if err != nil || output != "done" || len(caller.models) != 1 || len(caller.calls) != 0 {
		t.Fatalf("output=%q models=%v calls=%v err=%v", output, caller.models, caller.calls, err)
	}
	if caller.models[0].Role != "answer" {
		t.Fatalf("role=%q", caller.models[0].Role)
	}
}

func TestAuthorGuideToolsetMatchesTheFlatDeclarations(t *testing.T) {
	flat := func() (agent.Agent, error) {
		var tools []tool.Tool
		for _, name := range []string{"flat@1", "math.double@1", "last@1"} {
			created, err := galaxie.CapabilityTool(name, galaxie.ToolSpec{
				Description: "Double an integer.", Schema: doubleSchema,
			})
			if err != nil {
				return nil, err
			}
			tools = append(tools, created)
		}
		return galaxie.LlmAgent(llmagent.Config{Name: "root", Model: galaxie.Model("answer"), Tools: tools})
	}
	var flatDeclarations []llm.ToolDefinition
	for _, entry := range []galaxie.Entry{flat, buildGuideToolset} {
		caller := &scripted{
			replies:    []string{toolCall("math_double_1", `{"value":21}`), reply("done")},
			capability: func(llm.CapabilityRequest) (string, error) { return `{"value":42}`, nil },
		}
		output, err := galaxie.Execute(context.Background(), caller, entry, galaxie.Input{Prompt: "question", Conversation: "s"})
		if err != nil || output != "done" || len(caller.models) != 2 || len(caller.calls) != 1 {
			t.Fatalf("output=%q models=%v calls=%v err=%v", output, caller.models, caller.calls, err)
		}
		if caller.calls[0].Name != "math.double@1" || !reflect.DeepEqual(caller.calls[0].Input, map[string]any{"value": float64(21)}) {
			t.Fatalf("capability=%+v", caller.calls[0])
		}
		declarations := caller.models[0].Options.Tools
		var names []string
		for _, declaration := range declarations {
			names = append(names, declaration.Function.Name)
		}
		if !reflect.DeepEqual(names, []string{"flat_1", "math_double_1", "last_1"}) {
			t.Fatalf("declaration order=%v", names)
		}
		if flatDeclarations == nil {
			flatDeclarations = declarations
		} else if !reflect.DeepEqual(declarations, flatDeclarations) {
			t.Fatalf("flat=%+v grouped=%+v", flatDeclarations, declarations)
		}
	}
}

func TestAuthorGuideDuplicateToolsetRefusesBeforeDispatch(t *testing.T) {
	caller := &scripted{}
	_, err := galaxie.Execute(context.Background(), caller, func() (agent.Agent, error) {
		created, err := galaxie.CapabilityTool("math.double@1", galaxie.ToolSpec{Schema: doubleSchema})
		if err != nil {
			return nil, err
		}
		_, err = galaxie.Toolset(created, created)
		return nil, err
	}, galaxie.Input{Prompt: "question", Conversation: "s"})
	assertCode(t, err, "unsupported")
	if len(caller.models) != 0 || len(caller.calls) != 0 {
		t.Fatalf("models=%v calls=%v", caller.models, caller.calls)
	}
}
