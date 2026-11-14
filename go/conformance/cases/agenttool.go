// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package cases

import (
	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/model"
	"google.golang.org/adk/tool"
	"google.golang.org/genai"

	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

// AgentToolDefinitions registers the isolated-wrapper measurements independently of old cases.
func AgentToolDefinitions() map[string]galaxie.Definition {
	definitions := map[string]galaxie.Definition{}
	for _, kind := range []string{"plain", "state", "direct", "event", "direct-event", "capability", "confirmation", "long-running", "exit", "toolset", "nested", "input-schema", "output-schema", "duplicate", "collision", "foreign"} {
		definitions["agent-tool-"+kind] = galaxie.Definition{Build: AgentToolEntry(kind)}
	}
	return definitions
}

// AgentToolEntry builds a dedicated closed or refused shape for native and wasm gates.
func AgentToolEntry(kind string) galaxie.Entry {
	return func() (agent.Agent, error) {
		config := llmagent.Config{Name: "inner", Description: "Answer one question.", Model: galaxie.Model("inner"), OutputKey: "changed"}
		if kind == "state" {
			config.BeforeAgentCallbacks = []agent.BeforeAgentCallback{func(ctx agent.CallbackContext) (*genai.Content, error) {
				state := map[string]any{}
				for key, value := range ctx.State().All() {
					state[key] = value
				}
				if len(state) != 2 || state["ordinary"] != "copied" || state["temp:input"] != "temporary" {
					return nil, llm.NewError("invalid")
				}
				return nil, ctx.State().Set("inner_local", "isolated")
			}}
		}
		if kind == "input-schema" {
			config.InputSchema = &genai.Schema{Type: "OBJECT"}
		}
		if kind == "output-schema" {
			config.OutputSchema = &genai.Schema{Type: "OBJECT"}
		}
		if kind == "duplicate" {
			config.Name = "outer"
		}
		if kind == "event" || kind == "direct-event" {
			config.BeforeModelCallbacks = []llmagent.BeforeModelCallback{func(agent.CallbackContext, *model.LLMRequest) (*model.LLMResponse, error) {
				return &model.LLMResponse{ErrorCode: "SCRIPTED", ErrorMessage: "scripted failure"}, nil
			}}
		}
		if kind == "capability" || kind == "confirmation" || kind == "long-running" || kind == "toolset" {
			read, err := galaxie.CapabilityTool("notes.read@1", galaxie.ToolSpec{Description: "Read.", Schema: `{"type":"object"}`, RequireConfirmation: kind == "confirmation", LongRunning: kind == "long-running"})
			if err != nil {
				return nil, err
			}
			config.Tools = []tool.Tool{read}
			if kind == "toolset" {
				set, err := galaxie.Toolset(read)
				if err != nil {
					return nil, err
				}
				config.Tools, config.Toolsets = nil, []tool.Toolset{set}
			}
		}
		if kind == "exit" {
			exit, err := galaxie.ExitLoop()
			if err != nil {
				return nil, err
			}
			config.Tools = []tool.Tool{exit}
		}
		if kind == "nested" {
			child, err := galaxie.LlmAgent(llmagent.Config{Name: "nested", Model: galaxie.Model("inner")})
			if err != nil {
				return nil, err
			}
			wrapped, err := galaxie.AgentTool(child)
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
			inner, err = galaxie.LlmAgent(config)
		}
		if err != nil {
			return nil, err
		}
		if kind == "direct" || kind == "direct-event" {
			return inner, nil
		}
		wrapped, err := galaxie.AgentTool(inner)
		if err != nil {
			return nil, err
		}
		tools := []tool.Tool{wrapped}
		if kind == "collision" {
			other, err := galaxie.CapabilityTool("inner", galaxie.ToolSpec{Description: "Collision.", Schema: `{"type":"object"}`})
			if err != nil {
				return nil, err
			}
			tools = append(tools, other)
		}
		outer := llmagent.Config{Name: "outer", Model: galaxie.Model("outer"), Tools: tools}
		if kind == "state" {
			outer.BeforeAgentCallbacks = []agent.BeforeAgentCallback{func(ctx agent.CallbackContext) (*genai.Content, error) {
				for key, value := range map[string]any{"ordinary": "copied", "temp:input": "temporary", "_adk:private": "hidden"} {
					if err := ctx.State().Set(key, value); err != nil {
						return nil, err
					}
				}
				return nil, nil
			}}
			outer.AfterAgentCallbacks = []agent.AfterAgentCallback{func(ctx agent.CallbackContext) (*genai.Content, error) {
				for key := range ctx.State().All() {
					if key == "changed" || key == "inner_local" {
						return nil, llm.NewError("invalid")
					}
				}
				return nil, nil
			}}
		}
		return galaxie.LlmAgent(outer)
	}
}
