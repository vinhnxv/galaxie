// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/tool"
	"google.golang.org/genai"

	"galaxie.invalid/galaxie/galaxie/llm"
)

func agentToolEntry(kind string) Entry {
	return func() (agent.Agent, error) {
		config := llmagent.Config{Name: "inner", Description: "Answer one question.", Model: Model("inner"), OutputKey: "changed"}
		if kind == "duplicate" {
			config.Name = "outer"
		}
		if kind == "input-schema" {
			config.InputSchema = &genai.Schema{Type: "OBJECT"}
		}
		if kind == "output-schema" {
			config.OutputSchema = &genai.Schema{Type: "OBJECT"}
		}
		if kind == "capability" || kind == "confirmation" || kind == "long-running" || kind == "toolset" {
			read, err := CapabilityTool("notes.read@1", ToolSpec{Description: "Read.", Schema: `{"type":"object"}`, RequireConfirmation: kind == "confirmation", LongRunning: kind == "long-running"})
			if err != nil {
				return nil, err
			}
			config.Tools = []tool.Tool{read}
			if kind == "toolset" {
				set, err := Toolset(read)
				if err != nil {
					return nil, err
				}
				config.Tools = nil
				config.Toolsets = []tool.Toolset{set}
			}
		}
		if kind == "exit" {
			exit, err := ExitLoop()
			if err != nil {
				return nil, err
			}
			config.Tools = []tool.Tool{exit}
		}
		if kind == "nested" {
			nested, err := LlmAgent(llmagent.Config{Name: "nested", Model: Model("inner")})
			if err != nil {
				return nil, err
			}
			wrapped, err := AgentTool(nested)
			if err != nil {
				return nil, err
			}
			config.Tools = []tool.Tool{wrapped}
		}
		var inner agent.Agent
		var err error
		if kind == "foreign" {
			inner, err = llmagent.New(config)
		} else {
			inner, err = LlmAgent(config)
		}
		if err != nil {
			return nil, err
		}
		wrapped, err := AgentTool(inner)
		if err != nil {
			return nil, err
		}
		tools := []tool.Tool{wrapped}
		if kind == "collision" {
			other, err := CapabilityTool("inner", ToolSpec{Description: "Collision.", Schema: `{"type":"object"}`})
			if err != nil {
				return nil, err
			}
			tools = append(tools, other)
		}
		return LlmAgent(llmagent.Config{Name: "outer", Model: Model("outer"), Tools: tools})
	}
}

func TestAgentToolCandidateAdmissionIsCapabilityFreeAndClosed(t *testing.T) {
	for _, kind := range []string{"plain", "foreign", "nested", "input-schema", "output-schema", "capability", "confirmation", "long-running", "exit", "toolset", "collision", "duplicate"} {
		t.Run(kind, func(t *testing.T) {
			_, _, err := record(agentToolEntry(kind))
			if kind == "plain" {
				if err != nil {
					t.Fatal(err)
				}
			} else if llm.CodeOf(err) != "unsupported" {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

type agentToolCaller struct{ requests []llm.ModelRequest }

func (c *agentToolCaller) Call(_ context.Context, op string, payload []byte) ([]byte, error) {
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

func TestAgentToolCandidateRunsThreeRoutedCallsWithoutInnerStreaming(t *testing.T) {
	caller := &agentToolCaller{}
	result, err := NewStore().Run(context.Background(), caller, Definition{Build: agentToolEntry("plain")}, Input{Prompt: "go", Conversation: "c", Persist: true, Stream: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.Output != "outer answer" || len(caller.requests) != 3 {
		t.Fatalf("result=%+v requests=%v", result, caller.requests)
	}
	roles := []string{}
	for _, request := range caller.requests {
		roles = append(roles, request.Role)
	}
	if !reflect.DeepEqual(roles, []string{"outer", "inner", "outer"}) {
		t.Fatalf("roles=%v", roles)
	}
	if caller.requests[1].Options.Stream {
		t.Fatal("inner text reached the host stream")
	}
	if got := caller.requests[2].Messages[len(caller.requests[2].Messages)-1].Content; got != `{"result":"inner answer"}` {
		t.Fatalf("tool response=%s", got)
	}
	var record map[string]any
	if err := json.Unmarshal(result.Record, &record); err != nil {
		t.Fatal(err)
	}
}
