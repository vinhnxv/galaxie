// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

package galaxie

import (
	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/agent/workflowagents/loopagent"
	"google.golang.org/adk/agent/workflowagents/parallelagent"
	"google.golang.org/adk/agent/workflowagents/sequentialagent"

	"galaxie.invalid/galaxie/galaxie/llm"
)

// Model returns the model for a role the host routes. Calls go to galaxie's router, which applies
// the role's providers, labels, consent and budgets.
func Model(role string) *llm.LLM {
	model := llm.New(role)
	if r := active(); r != nil {
		r.models[model] = true
	}
	return model
}

// LlmAgent creates an ADK LlmAgent. Its Model must come from Model and its Tools from
// CapabilityTool or ExitLoop; toolsets are not supported.
func LlmAgent(config llmagent.Config) (agent.Agent, error) {
	r := active()
	if r == nil {
		return nil, llm.NewError("unsupported")
	}
	model, ok := config.Model.(*llm.LLM)
	if !ok || !r.models[model] || len(config.Toolsets) > 0 {
		return nil, llm.NewError("unsupported")
	}
	for _, each := range config.Tools {
		if !r.tools[each] {
			return nil, llm.NewError("unsupported")
		}
	}
	created, err := llmagent.New(config)
	if err != nil {
		return nil, err
	}
	r.agents[created] = node{model: model, tools: config.Tools}
	return created, nil
}

// SequentialAgent creates an ADK SequentialAgent over agents the constructors created.
func SequentialAgent(config agent.Config) (agent.Agent, error) {
	return workflow(config, func(config agent.Config) (agent.Agent, error) {
		return sequentialagent.New(sequentialagent.Config{AgentConfig: config})
	})
}

// ParallelAgent creates an ADK ParallelAgent over agents the constructors created.
func ParallelAgent(config agent.Config) (agent.Agent, error) {
	return workflow(config, func(config agent.Config) (agent.Agent, error) {
		return parallelagent.New(parallelagent.Config{AgentConfig: config})
	})
}

// LoopAgent creates an ADK LoopAgent. A loop needs MaxIterations, or a sub-agent with ExitLoop,
// so it cannot run without bound.
func LoopAgent(config agent.Config, maxIterations uint) (agent.Agent, error) {
	created, err := workflow(config, func(config agent.Config) (agent.Agent, error) {
		return loopagent.New(loopagent.Config{AgentConfig: config, MaxIterations: maxIterations})
	})
	if err != nil {
		return nil, err
	}
	if maxIterations == 0 && !hasExitLoop(created) {
		return nil, llm.NewError("unsupported")
	}
	return created, nil
}

func workflow(config agent.Config, create func(agent.Config) (agent.Agent, error)) (agent.Agent, error) {
	r := active()
	if r == nil {
		return nil, llm.NewError("unsupported")
	}
	for _, child := range config.SubAgents {
		if _, ok := r.agents[child]; !ok {
			return nil, llm.NewError("unsupported")
		}
	}
	created, err := create(config)
	if err != nil {
		return nil, err
	}
	r.agents[created] = node{}
	return created, nil
}

// hasExitLoop reports whether any LlmAgent below the loop carries the exit tool.
func hasExitLoop(root agent.Agent) bool {
	r := active()
	for _, child := range root.SubAgents() {
		if info := r.agents[child]; info.model != nil {
			for _, each := range info.tools {
				if each.Name() == exitLoopName {
					return true
				}
			}
		}
		if hasExitLoop(child) {
			return true
		}
	}
	return false
}
