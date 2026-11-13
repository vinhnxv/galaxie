// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie

import (
	"slices"

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
// CapabilityTool or ExitLoop. Toolsets must come from Toolset in the same build.
func LlmAgent(config llmagent.Config) (agent.Agent, error) {
	r := active()
	if r == nil {
		return nil, llm.NewError("unsupported")
	}
	model, ok := config.Model.(*llm.LLM)
	if !ok || !r.models[model] {
		return nil, llm.NewError("unsupported")
	}
	for _, each := range config.Tools {
		if !r.tools[each] {
			return nil, llm.NewError("unsupported")
		}
	}
	tools := slices.Clone(config.Tools)
	for _, each := range config.Toolsets {
		set, ok := each.(*fixedToolset)
		if !ok || !r.toolsets[set] {
			return nil, llm.NewError("unsupported")
		}
		for _, member := range set.tools {
			if !r.capabilityTools[member] {
				return nil, llm.NewError("unsupported")
			}
		}
		tools = append(tools, set.tools...)
	}
	if len(config.Toolsets) > 0 {
		names := make(map[string]bool, len(tools))
		for _, each := range tools {
			if names[each.Name()] {
				return nil, llm.NewError("unsupported")
			}
			names[each.Name()] = true
		}
	}
	config.Tools = tools
	config.Toolsets = nil
	created, err := llmagent.New(config)
	if err != nil {
		return nil, err
	}
	r.agents[created] = node{kind: kindLLM, model: model, tools: config.Tools}
	return created, nil
}

// SequentialAgent creates an ADK SequentialAgent over agents the constructors created.
func SequentialAgent(config agent.Config) (agent.Agent, error) {
	return workflow(kindSequential, config, func(config agent.Config) (agent.Agent, error) {
		return sequentialagent.New(sequentialagent.Config{AgentConfig: config})
	})
}

// ParallelAgent creates an ADK ParallelAgent over agents the constructors created.
func ParallelAgent(config agent.Config) (agent.Agent, error) {
	return workflow(kindParallel, config, func(config agent.Config) (agent.Agent, error) {
		return parallelagent.New(parallelagent.Config{AgentConfig: config})
	})
}

// LoopAgent creates an ADK LoopAgent. A loop needs MaxIterations, or a sub-agent with ExitLoop,
// so it cannot run without bound.
func LoopAgent(config agent.Config, maxIterations uint) (agent.Agent, error) {
	created, err := workflow(kindLoop, config, func(config agent.Config) (agent.Agent, error) {
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

func workflow(kind string, config agent.Config, create func(agent.Config) (agent.Agent, error)) (agent.Agent, error) {
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
	r.agents[created] = node{kind: kind}
	return created, nil
}

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
