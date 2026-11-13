// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/tool"
	"google.golang.org/adk/tool/functiontool"
	"google.golang.org/adk/tool/geminitool"

	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

func fixedToolsetEntry() (agent.Agent, error) {
	double, err := galaxie.CapabilityTool("math.double@1", galaxie.ToolSpec{Description: "Double an integer.", Schema: doubleSchema})
	if err != nil {
		return nil, err
	}
	set, err := galaxie.Toolset(double)
	if err != nil {
		return nil, err
	}
	return galaxie.LlmAgent(llmagent.Config{Name: "agent", Model: galaxie.Model("answer"), Toolsets: []tool.Toolset{set}})
}

func inventoryTools(t *testing.T, confirm bool) []tool.Tool {
	t.Helper()
	var tools []tool.Tool
	for _, name := range []string{"flat@1", "math.double@1", "last@1"} {
		created, err := galaxie.CapabilityTool(name, galaxie.ToolSpec{
			Description: "Double an integer.", Schema: doubleSchema,
			RequireConfirmation: confirm && name == "math.double@1",
		})
		if err != nil {
			t.Fatal(err)
		}
		tools = append(tools, created)
	}
	return tools
}

func groupedInventoryEntry(t *testing.T, grouped, confirm bool) galaxie.Entry {
	t.Helper()
	return func() (agent.Agent, error) {
		tools := inventoryTools(t, confirm)
		config := llmagent.Config{Name: "agent", Model: galaxie.Model("answer"), Tools: tools}
		if grouped {
			set, err := galaxie.Toolset(tools[1:]...)
			if err != nil {
				return nil, err
			}
			config.Tools, config.Toolsets = tools[:1], []tool.Toolset{set}
		}
		return galaxie.LlmAgent(config)
	}
}

func TestFixedToolsetMatchesNativeAndFlatDeclarationOrder(t *testing.T) {
	var inputSchema jsonschema.Schema
	if err := json.Unmarshal([]byte(doubleSchema), &inputSchema); err != nil {
		t.Fatal(err)
	}
	var nativeTools []tool.Tool
	nativeCalls := 0
	for _, name := range []string{"flat_1", "math_double_1", "last_1"} {
		created, err := functiontool.New(functiontool.Config{
			Name: name, Description: "Double an integer.", InputSchema: &inputSchema,
		}, func(_ agent.ToolContext, _ map[string]any) (map[string]any, error) {
			nativeCalls++
			return map[string]any{"value": 6}, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		nativeTools = append(nativeTools, created)
	}
	oracle := &shapeNative{withTool: true}
	nativeSet := &shapeToolset{fixed: nativeTools[1:]}
	root, err := llmagent.New(llmagent.Config{
		Name: "agent", Model: oracle, Tools: nativeTools[:1], Toolsets: []tool.Toolset{nativeSet},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := shapeNativeRun(t, root)
	if want != "done" || nativeCalls != 1 || nativeSet.calls < 2 {
		t.Fatalf("native output=%q calls=%d expansions=%d", want, nativeCalls, nativeSet.calls)
	}
	for _, grouped := range []bool{false, true} {
		caller := &scripted{
			replies:    []string{toolCall("math_double_1", `{"value":3}`), reply("done")},
			capability: echoCapability,
		}
		got, err := galaxie.Execute(context.Background(), caller, groupedInventoryEntry(t, grouped, false), galaxie.Input{Prompt: "question", Conversation: "s"})
		if err != nil || got != want || len(caller.models) != 2 || len(caller.calls) != 1 {
			t.Fatalf("grouped=%t output=%q calls=%v err=%v", grouped, got, caller.calls, err)
		}
		if !reflect.DeepEqual(oracle.wires[0].Options.Tools, caller.models[0].Options.Tools) {
			t.Fatalf("native=%+v actual=%+v", oracle.wires[0].Options.Tools, caller.models[0].Options.Tools)
		}
		var names []string
		for _, declaration := range caller.models[0].Options.Tools {
			names = append(names, declaration.Function.Name)
		}
		if !reflect.DeepEqual(names, []string{"flat_1", "math_double_1", "last_1"}) {
			t.Fatalf("declaration order=%v", names)
		}
	}
}

func TestFixedToolsetCopiesInputAndEachReturnedSlice(t *testing.T) {
	caller := &scripted{replies: []string{reply("done")}}
	_, err := galaxie.Execute(context.Background(), caller, func() (agent.Agent, error) {
		tools := inventoryTools(t, false)
		members := append([]tool.Tool(nil), tools[1:]...)
		set, err := galaxie.Toolset(members...)
		if err != nil {
			return nil, err
		}
		members[0] = geminitool.GoogleSearch{}
		first, err := set.Tools(nil)
		if err != nil {
			return nil, err
		}
		first[0] = geminitool.GoogleSearch{}
		second, err := set.Tools(nil)
		if err != nil || len(second) != 2 || second[0] != tools[1] || second[1] != tools[2] {
			t.Fatalf("fixed members changed: %v err=%v", second, err)
		}
		flat := make([]tool.Tool, 1, 3)
		flat[0] = tools[0]
		backing := flat[:cap(flat)]
		backing[1], backing[2] = geminitool.GoogleSearch{}, geminitool.GoogleSearch{}
		root, err := galaxie.LlmAgent(llmagent.Config{Name: "agent", Model: galaxie.Model("answer"), Tools: flat, Toolsets: []tool.Toolset{set}})
		if backing[1] != (geminitool.GoogleSearch{}) || backing[2] != (geminitool.GoogleSearch{}) {
			t.Fatal("flattening aliased the author's flat-tool slice")
		}
		return root, err
	}, galaxie.Input{Prompt: "question", Conversation: "s"})
	if err != nil || len(caller.models) != 1 || len(caller.models[0].Options.Tools) != 3 {
		t.Fatalf("models=%v err=%v", caller.models, err)
	}
}

type throwingInventoryToolset struct{ calls *int }

func (*throwingInventoryToolset) Name() string { return "foreign" }
func (s *throwingInventoryToolset) Tools(agent.ReadonlyContext) ([]tool.Tool, error) {
	*s.calls++
	panic("foreign expansion must not run")
}

type nestedInventoryToolset struct{ tool.Toolset }

func (*nestedInventoryToolset) Description() string { return "Nested." }
func (*nestedInventoryToolset) IsLongRunning() bool { return false }

type nonComparableInventoryTool []string

func (nonComparableInventoryTool) Name() string        { panic("foreign name must not run") }
func (nonComparableInventoryTool) Description() string { return "Foreign." }
func (nonComparableInventoryTool) IsLongRunning() bool { return false }

func TestFixedToolsetRefusesNeighboursBeforeDispatch(t *testing.T) {
	var oldTool tool.Tool
	var oldSet tool.Toolset
	var err error
	firstCaller := &scripted{replies: []string{reply("done")}}
	_, err = galaxie.Execute(context.Background(), firstCaller, func() (agent.Agent, error) {
		oldTool, err = galaxie.CapabilityTool("old@1", galaxie.ToolSpec{Schema: doubleSchema})
		if err != nil {
			return nil, err
		}
		oldSet, err = galaxie.Toolset(oldTool)
		if err != nil {
			return nil, err
		}
		return galaxie.LlmAgent(llmagent.Config{Name: "agent", Model: galaxie.Model("answer")})
	}, galaxie.Input{Prompt: "question", Conversation: "old"})
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"empty", "nil", "old-tool", "old-set", "direct", "builtin", "exit", "nested", "duplicate", "same-name", "flat-duplicate", "sets-duplicate", "foreign-set", "filtered", "non-comparable"} {
		t.Run(kind, func(t *testing.T) {
			caller := &scripted{}
			expansions := 0
			_, err := galaxie.Execute(context.Background(), caller, func() (agent.Agent, error) {
				tools := inventoryTools(t, false)
				set, err := galaxie.Toolset(tools[1])
				if err != nil {
					return nil, err
				}
				config := llmagent.Config{Name: "agent", Model: galaxie.Model("answer"), Toolsets: []tool.Toolset{set}}
				switch kind {
				case "empty":
					_, err = galaxie.Toolset()
				case "nil":
					_, err = galaxie.Toolset(nil)
				case "old-tool":
					_, err = galaxie.Toolset(oldTool)
				case "old-set":
					config.Toolsets = []tool.Toolset{oldSet}
				case "direct":
					foreign, createErr := functiontool.New(functiontool.Config{Name: "direct"}, func(_ agent.ToolContext, _ map[string]any) (map[string]any, error) { return nil, nil })
					if createErr != nil {
						return nil, createErr
					}
					_, err = galaxie.Toolset(foreign)
				case "builtin":
					_, err = galaxie.Toolset(geminitool.GoogleSearch{})
				case "exit":
					var exit tool.Tool
					exit, err = galaxie.ExitLoop()
					if err == nil {
						_, err = galaxie.Toolset(exit)
					}
				case "nested":
					_, err = galaxie.Toolset(&nestedInventoryToolset{Toolset: set})
				case "duplicate":
					_, err = galaxie.Toolset(tools[1], tools[1])
				case "same-name":
					var duplicate tool.Tool
					duplicate, err = galaxie.CapabilityTool("math_double_1", galaxie.ToolSpec{Schema: doubleSchema})
					if err == nil {
						_, err = galaxie.Toolset(tools[1], duplicate)
					}
				case "flat-duplicate":
					config.Tools = []tool.Tool{tools[1]}
				case "sets-duplicate":
					config.Toolsets = []tool.Toolset{set, set}
				case "foreign-set":
					config.Toolsets = []tool.Toolset{&throwingInventoryToolset{calls: &expansions}}
				case "filtered":
					config.Toolsets = []tool.Toolset{tool.FilterToolset(set, func(agent.ReadonlyContext, tool.Tool) bool { expansions++; return true })}
				case "non-comparable":
					_, err = galaxie.Toolset(nonComparableInventoryTool{"x"})
				}
				if err != nil {
					return nil, err
				}
				return galaxie.LlmAgent(config)
			}, galaxie.Input{Prompt: "question", Conversation: "s"})
			assertCode(t, err, "unsupported")
			if err.Error() != "This operation is unsupported." || expansions != 0 || len(caller.models) != 0 || len(caller.calls) != 0 {
				t.Fatalf("err=%v expansions=%d models=%v calls=%v", err, expansions, caller.models, caller.calls)
			}
		})
	}
	if _, err := galaxie.Toolset(oldTool); llm.CodeOf(err) != "unsupported" {
		t.Fatalf("toolset outside build: %v", err)
	}
}

func TestFixedToolsetPreservesConfirmationAndPausePositionRules(t *testing.T) {
	var previousModels []llm.ModelRequest
	var previousCalls []llm.CapabilityRequest
	var previousID string
	for _, grouped := range []bool{false, true} {
		caller := &scripted{replies: []string{toolCall("math_double_1", `{"value":3}`), reply("done")}, capability: echoCapability}
		definition := definitionOf(groupedInventoryEntry(t, grouped, true))
		store := galaxie.NewStore()
		pause, err := store.Run(context.Background(), caller, definition, galaxie.Input{Prompt: "question", Conversation: "s", Persist: true})
		if err != nil || pause.Pause == nil || len(caller.calls) != 0 {
			t.Fatalf("pause=%+v calls=%v err=%v", pause, caller.calls, err)
		}
		done, err := galaxie.NewStore().Run(context.Background(), caller, definition, galaxie.Input{
			Conversation: "s", Persist: true, Restore: pause.Record,
			Resume: &galaxie.Resumption{InteractionID: pause.Pause.ID, Action: "approve", Payload: approveAll(1)},
		})
		if err != nil || done.Output != "done" || len(caller.calls) != 1 || caller.calls[0].EffectScope != "adk-go/s/root/1/0" {
			t.Fatalf("done=%+v calls=%v err=%v", done, caller.calls, err)
		}
		if previousID != "" && (!reflect.DeepEqual(previousModels, caller.models) || !reflect.DeepEqual(previousCalls, caller.calls) || previousID != pause.Pause.ID) {
			t.Fatal("fixed toolset changed confirmation, requests or effects across reload")
		}
		previousModels, previousCalls, previousID = caller.models, caller.calls, pause.Pause.ID
	}
	for _, longRunning := range []bool{false, true} {
		for _, grouped := range []bool{false, true} {
			for _, kind := range []string{"parallel", "loop", "sequential-first"} {
				caller := &scripted{replies: []string{toolCall("math_double_1", `{"value":3}`)}}
				definition := definitionOf(func() (agent.Agent, error) {
					held, err := galaxie.CapabilityTool("math.double@1", galaxie.ToolSpec{
						Schema: doubleSchema, RequireConfirmation: !longRunning, LongRunning: longRunning,
					})
					if err != nil {
						return nil, err
					}
					llmConfig := llmagent.Config{Name: "agent", Model: galaxie.Model("answer"), Tools: []tool.Tool{held}}
					if grouped {
						set, err := galaxie.Toolset(held)
						if err != nil {
							return nil, err
						}
						llmConfig.Tools, llmConfig.Toolsets = nil, []tool.Toolset{set}
					}
					leaf, err := galaxie.LlmAgent(llmConfig)
					if err != nil {
						return nil, err
					}
					config := agent.Config{Name: "root", SubAgents: []agent.Agent{leaf}}
					switch kind {
					case "parallel":
						return galaxie.ParallelAgent(config)
					case "loop":
						return galaxie.LoopAgent(config, 2)
					default:
						last, err := galaxie.LlmAgent(llmagent.Config{Name: "last", Model: galaxie.Model("answer")})
						if err != nil {
							return nil, err
						}
						config.SubAgents = append(config.SubAgents, last)
						return galaxie.SequentialAgent(config)
					}
				})
				_, err := galaxie.NewStore().Run(context.Background(), caller, definition, galaxie.Input{Prompt: "question", Conversation: "s"})
				wantModels := 1
				if longRunning {
					wantModels = 0
				}
				var failure *llm.Error
				if !errors.As(err, &failure) || failure.Code != "unsupported" || len(caller.models) != wantModels || len(caller.calls) != 0 {
					t.Fatalf("position=%s grouped=%t longRunning=%t err=%v models=%v calls=%v", kind, grouped, longRunning, err, caller.models, caller.calls)
				}
			}
		}
	}
}

func TestFixedToolsetRunsTheRegisteredCapability(t *testing.T) {
	caller := &scripted{
		replies:    []string{toolCall("math_double_1", `{"value":3}`), reply("done")},
		capability: echoCapability,
	}
	output, err := galaxie.Execute(context.Background(), caller, fixedToolsetEntry, galaxie.Input{Prompt: "question", Conversation: "s"})
	if err != nil || output != "done" || len(caller.calls) != 1 || caller.calls[0].EffectScope != "adk-go/s/root/1/0" {
		t.Fatalf("output=%q calls=%v err=%v", output, caller.calls, err)
	}
}
