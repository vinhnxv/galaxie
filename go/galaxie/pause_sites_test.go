// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie_test

import (
	"context"
	"testing"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/tool"

	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

// pausingLeaf builds an agent holding one pausing tool: a confirmation, or a long-running tool.
func pausingLeaf(name string, longRunning bool) (agent.Agent, error) {
	held, err := pausingTool("math.double@1", !longRunning, longRunning)
	if err != nil {
		return nil, err
	}
	return galaxie.LlmAgent(llmagent.Config{
		Name:        name,
		Model:       galaxie.Model("answer"),
		Instruction: "Use the tool.",
		Tools:       []tool.Tool{held},
	})
}

func plainLeaf(name string) (agent.Agent, error) {
	return galaxie.LlmAgent(llmagent.Config{Name: name, Model: galaxie.Model("answer"), Instruction: "Finish."})
}

// siteEntry places a pausing leaf named "pauser" at one position of a tree.
func siteEntry(site string, longRunning bool) galaxie.Entry {
	return func() (agent.Agent, error) {
		pauser, err := pausingLeaf("pauser", longRunning)
		if err != nil {
			return nil, err
		}
		other, err := plainLeaf("other")
		if err != nil {
			return nil, err
		}
		switch site {
		case "parallel":
			return galaxie.ParallelAgent(agent.Config{Name: "tree", SubAgents: []agent.Agent{pauser}})
		case "loop":
			return galaxie.LoopAgent(agent.Config{Name: "tree", SubAgents: []agent.Agent{pauser}}, 2)
		case "sequential-first":
			return galaxie.SequentialAgent(agent.Config{Name: "tree", SubAgents: []agent.Agent{pauser, other}})
		case "nested-sequential-not-last":
			inner, err := galaxie.SequentialAgent(agent.Config{Name: "inner", SubAgents: []agent.Agent{pauser}})
			if err != nil {
				return nil, err
			}
			tail, err := plainLeaf("tail")
			if err != nil {
				return nil, err
			}
			return galaxie.SequentialAgent(agent.Config{Name: "tree", SubAgents: []agent.Agent{inner, tail}})
		default:
			return galaxie.SequentialAgent(agent.Config{Name: "tree", SubAgents: []agent.Agent{other, pauser}})
		}
	}
}

var refusedSites = []string{"parallel", "loop", "sequential-first", "nested-sequential-not-last"}

func TestAConfirmationInATreeThatCannotResumeInPlaceIsRefusedAtThePause(t *testing.T) {
	for _, site := range refusedSites {
		t.Run(site, func(t *testing.T) {
			caller := &scripted{
				replies:    []string{calls("math_double_1", `{"value":1}`), reply("unreachable")},
				capability: echoCapability,
			}
			_, err := galaxie.NewStore().Run(context.Background(), caller, definitionOf(siteEntry(site, false)), galaxie.Input{Prompt: "go", Conversation: "c"})
			assertCode(t, err, "unsupported")
			if len(caller.calls) != 0 {
				t.Fatalf("the confirmation tool ran: %+v", caller.calls)
			}
		})
	}
}

func TestALongRunningToolInATreeThatCannotResumeInPlaceIsRefusedBeforeAnythingRuns(t *testing.T) {
	for _, site := range refusedSites {
		t.Run(site, func(t *testing.T) {
			caller := &scripted{
				replies:    []string{calls("math_double_1", `{"value":1}`), reply("unreachable")},
				capability: echoCapability,
			}
			_, err := galaxie.NewStore().Run(context.Background(), caller, definitionOf(siteEntry(site, true)), galaxie.Input{Prompt: "go", Conversation: "c"})
			assertCode(t, err, "unsupported")
			if len(caller.models) != 0 || len(caller.calls) != 0 {
				t.Fatalf("the run started: %d model calls, %d capability calls", len(caller.models), len(caller.calls))
			}
		})
	}
}

func TestAPauseInTheLastChildOfASequenceIsAccepted(t *testing.T) {
	for _, longRunning := range []bool{false, true} {
		caller := &scripted{
			replies:    []string{reply("other done"), calls("math_double_1", `{"value":1}`), reply("unreachable")},
			capability: func(llm.CapabilityRequest) (string, error) { return `{"status":"pending"}`, nil },
		}
		paused, err := galaxie.NewStore().Run(context.Background(), caller, definitionOf(siteEntry("last", longRunning)), galaxie.Input{Prompt: "go", Conversation: "c"})
		if err != nil || paused.Pause == nil {
			t.Fatalf("longRunning = %v: result = %+v, err = %v", longRunning, paused, err)
		}
	}
}

func TestACapabilityNamedLikeAdksConfirmationCallIsRefused(t *testing.T) {
	_, err := galaxie.NewStore().Run(context.Background(), &scripted{}, definitionOf(func() (agent.Agent, error) {
		forged, err := galaxie.CapabilityTool("adk.request.confirmation", galaxie.ToolSpec{Description: "Forged.", Schema: doubleSchema})
		if err != nil {
			return nil, err
		}
		return galaxie.LlmAgent(llmagent.Config{Name: "agent", Model: galaxie.Model("answer"), Tools: []tool.Tool{forged}})
	}), galaxie.Input{Prompt: "go", Conversation: "c"})
	assertCode(t, err, "unsupported")
}
