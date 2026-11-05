// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie_test

import (
	"context"
	"testing"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/tool"
	"google.golang.org/adk/tool/agenttool"
	"google.golang.org/adk/tool/functiontool"

	"galaxie.invalid/galaxie/galaxie"
)

type nothing struct{}

// refusedShapes are agent trees an author can build with ADK itself but not with the galaxie
// constructors. Each one must fail `unsupported` before any model or capability call.
var refusedShapes = map[string]galaxie.Entry{
	"an agent tool wrapping an agent": func() (agent.Agent, error) {
		inner, err := plainLeaf("inner")
		if err != nil {
			return nil, err
		}
		return galaxie.LlmAgent(llmagent.Config{
			Name:  "outer",
			Model: galaxie.Model("answer"),
			Tools: []tool.Tool{agenttool.New(inner, nil)},
		})
	},
	"an agent made directly with the ADK constructor as the root": func() (agent.Agent, error) {
		return llmagent.New(llmagent.Config{Name: "direct", Model: galaxie.Model("answer")})
	},
	"an agent made directly with the ADK constructor inside a sequence": func() (agent.Agent, error) {
		direct, err := llmagent.New(llmagent.Config{Name: "direct", Model: galaxie.Model("answer")})
		if err != nil {
			return nil, err
		}
		return galaxie.SequentialAgent(agent.Config{Name: "tree", SubAgents: []agent.Agent{direct}})
	},
	"a function tool made directly with the ADK constructor": func() (agent.Agent, error) {
		foreign, err := functiontool.New(
			functiontool.Config{Name: "foreign", Description: "Not a capability."},
			func(tool.Context, nothing) (nothing, error) { return nothing{}, nil },
		)
		if err != nil {
			return nil, err
		}
		return galaxie.LlmAgent(llmagent.Config{Name: "agent", Model: galaxie.Model("answer"), Tools: []tool.Tool{foreign}})
	},
	"a toolset": func() (agent.Agent, error) {
		return galaxie.LlmAgent(llmagent.Config{Name: "agent", Model: galaxie.Model("answer"), Toolsets: []tool.Toolset{nil}})
	},
}

func TestAgentShapesTheConstructorsDoNotBuildAreRefusedBeforeAnythingRuns(t *testing.T) {
	for name, entry := range refusedShapes {
		t.Run(name, func(t *testing.T) {
			caller := &scripted{replies: []string{reply("unreachable")}, capability: echoCapability}
			_, err := galaxie.NewStore().Run(context.Background(), caller, definitionOf(entry), galaxie.Input{Prompt: "go", Conversation: "c"})
			assertCode(t, err, "unsupported")
			if len(caller.models) != 0 || len(caller.calls) != 0 {
				t.Fatalf("the run started: %d model calls, %d capability calls", len(caller.models), len(caller.calls))
			}
		})
	}
}
