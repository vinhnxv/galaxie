// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Package cases holds the agents the ADK Go conformance lane runs. The same entries run natively
// against a scripted caller to record the goldens, and compiled into the reference module they run
// in the Worker against the real adapter, so a difference between the two is a defect in the
// bridge and never in the agents.
package cases

import (
	"os"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/model"
	"google.golang.org/adk/tool"

	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

const doubleSchema = `{"type":"object","properties":{"value":{"type":"integer"}},"required":["value"]}`

// Definitions returns every conformance entry by name, with the pause handling of the ones that can
// pause.
func Definitions() map[string]galaxie.Definition {
	plain := map[string]galaxie.Entry{
		"single":       single,
		"single-tool":  singleTool,
		"sequential":   sequential,
		"bounded-loop": boundedLoop,
		"exit-loop":    exitLoop,
		"unbounded":    unbounded,
		"spin":         spin,
		"panic":        panicking,
		"exit":         exiting,
	}
	definitions := make(map[string]galaxie.Definition, len(plain)+5)
	for name, entry := range plain {
		definitions[name] = galaxie.Definition{Build: entry}
	}
	definitions["confirm"] = galaxie.Definition{Build: confirm, Interaction: approval}
	definitions["confirm-sequential"] = galaxie.Definition{Build: confirmLast, Interaction: approval}
	definitions["confirm-sequential-first"] = galaxie.Definition{Build: confirmFirst, Interaction: approval}
	definitions["long-running"] = galaxie.Definition{Build: longRunning, Interaction: approval, Resume: completion}
	return definitions
}

// approval shows one Approval component for every pause; the count is all the page needs to see.
func approval(requests []galaxie.Request) (map[string]any, error) {
	return map[string]any{
		"surfaceId":    "main",
		"viewRevision": "r1",
		"component":    "conformance.Approval/v1",
		"props":        map[string]any{"count": len(requests)},
	}, nil
}

// completion answers a long-running request with the value the user sends.
func completion(requests []galaxie.Request, action string, payload any) ([]galaxie.Decision, error) {
	fields, ok := payload.(map[string]any)
	value, numeric := fields["value"].(float64)
	if action != "complete" || len(requests) != 1 || !ok || !numeric || len(fields) != 1 {
		return nil, llm.NewError("invalid")
	}
	return []galaxie.Decision{galaxie.Respond(map[string]any{"value": value})}, nil
}

func leaf(name string, tools ...tool.Tool) (agent.Agent, error) {
	return galaxie.LlmAgent(llmagent.Config{
		Name:        name,
		Model:       galaxie.Model("answer"),
		Instruction: "Answer briefly.",
		Tools:       tools,
	})
}

func single() (agent.Agent, error) { return leaf("agent") }

func singleTool() (agent.Agent, error) {
	double, err := galaxie.CapabilityTool("math.double@1", galaxie.ToolSpec{
		Description: "Double an integer.",
		Schema:      doubleSchema,
	})
	if err != nil {
		return nil, err
	}
	return leaf("agent", double)
}

func pausing(name string, confirmation, longRunning bool) (agent.Agent, error) {
	double, err := galaxie.CapabilityTool("math.double@1", galaxie.ToolSpec{
		Description:         "Double an integer.",
		Schema:              doubleSchema,
		RequireConfirmation: confirmation,
		LongRunning:         longRunning,
	})
	if err != nil {
		return nil, err
	}
	return leaf(name, double)
}

func confirm() (agent.Agent, error) { return pausing("agent", true, false) }

func longRunning() (agent.Agent, error) { return pausing("agent", false, true) }

func plainLeaf(name string) (agent.Agent, error) { return leaf(name) }

// confirmLast pauses in the last child of a sequence, which ADK resumes without losing a sibling.
func confirmLast() (agent.Agent, error) {
	first, err := plainLeaf("first")
	if err != nil {
		return nil, err
	}
	second, err := pausing("second", true, false)
	if err != nil {
		return nil, err
	}
	return galaxie.SequentialAgent(agent.Config{Name: "pipeline", SubAgents: []agent.Agent{first, second}})
}

// confirmFirst pauses in the first child of a sequence; the resume would skip the second child, so
// the adapter refuses it.
func confirmFirst() (agent.Agent, error) {
	first, err := pausing("first", true, false)
	if err != nil {
		return nil, err
	}
	second, err := plainLeaf("second")
	if err != nil {
		return nil, err
	}
	return galaxie.SequentialAgent(agent.Config{Name: "pipeline", SubAgents: []agent.Agent{first, second}})
}

func sequential() (agent.Agent, error) {
	first, err := galaxie.LlmAgent(llmagent.Config{
		Name:        "first",
		Model:       galaxie.Model("answer"),
		Instruction: "Draft an answer.",
		OutputKey:   "draft",
	})
	if err != nil {
		return nil, err
	}
	second, err := galaxie.LlmAgent(llmagent.Config{
		Name:        "second",
		Model:       galaxie.Model("answer"),
		Instruction: "Polish this draft: {draft}",
	})
	if err != nil {
		return nil, err
	}
	return galaxie.SequentialAgent(agent.Config{Name: "pipeline", SubAgents: []agent.Agent{first, second}})
}

func boundedLoop() (agent.Agent, error) {
	worker, err := leaf("worker")
	if err != nil {
		return nil, err
	}
	return galaxie.LoopAgent(agent.Config{Name: "refine", SubAgents: []agent.Agent{worker}}, 2)
}

func exitLoop() (agent.Agent, error) {
	finish, err := galaxie.ExitLoop()
	if err != nil {
		return nil, err
	}
	worker, err := leaf("worker", finish)
	if err != nil {
		return nil, err
	}
	return galaxie.LoopAgent(agent.Config{Name: "refine", SubAgents: []agent.Agent{worker}}, 0)
}

func unbounded() (agent.Agent, error) {
	worker, err := leaf("worker")
	if err != nil {
		return nil, err
	}
	return galaxie.LoopAgent(agent.Config{Name: "forever", SubAgents: []agent.Agent{worker}}, 0)
}

func hooked(before llmagent.BeforeModelCallback) (agent.Agent, error) {
	return galaxie.LlmAgent(llmagent.Config{
		Name:                 "agent",
		Model:                galaxie.Model("answer"),
		BeforeModelCallbacks: []llmagent.BeforeModelCallback{before},
	})
}

func spin() (agent.Agent, error) {
	return hooked(func(agent.CallbackContext, *model.LLMRequest) (*model.LLMResponse, error) {
		for {
		}
	})
}

func panicking() (agent.Agent, error) {
	return hooked(func(agent.CallbackContext, *model.LLMRequest) (*model.LLMResponse, error) {
		panic("conformance panic")
	})
}

func exiting() (agent.Agent, error) {
	return hooked(func(agent.CallbackContext, *model.LLMRequest) (*model.LLMResponse, error) {
		os.Exit(3)
		return nil, nil
	})
}
