// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Package cases holds the agents the ADK Go conformance lane runs. The same entries run natively
// against a scripted caller to record the goldens, and compiled into the reference module they run
// in the Worker against the real adapter, so a difference between the two is a defect in the
// bridge and never in the agents.
package cases

import (
	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/tool"

	"galaxie.invalid/galaxie/galaxie"
)

const doubleSchema = `{"type":"object","properties":{"value":{"type":"integer"}},"required":["value"]}`

// Entries returns every conformance entry by name.
func Entries() map[string]galaxie.Entry {
	return map[string]galaxie.Entry{
		"single":       single,
		"single-tool":  singleTool,
		"sequential":   sequential,
		"bounded-loop": boundedLoop,
		"exit-loop":    exitLoop,
		"unbounded":    unbounded,
	}
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

// unbounded has neither a maximum nor an exit tool, so the registry refuses it.
func unbounded() (agent.Agent, error) {
	worker, err := leaf("worker")
	if err != nil {
		return nil, err
	}
	return galaxie.LoopAgent(agent.Config{Name: "forever", SubAgents: []agent.Agent{worker}}, 0)
}
