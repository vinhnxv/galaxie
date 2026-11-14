// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Package galaxie hosts Google ADK Go agents inside galaxie. An agent module builds its agents with
// the constructors here instead of the ADK ones, so the executor can check that every agent, tool
// and model it runs came from a reviewed constructor: models call the host's router, tools call
// host capabilities, and nothing carries a provider key or a network client.
package galaxie

import (
	"sync"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/tool"

	"galaxie.invalid/galaxie/galaxie/llm"
)

const maxDepth = 16

// Agent kinds the constructors create.
const (
	kindLLM        = "llm"
	kindSequential = "sequential"
	kindParallel   = "parallel"
	kindLoop       = "loop"
)

type node struct {
	kind  string
	model *llm.LLM
	tools []tool.Tool
}

// recorder collects the values one build function creates. The ADK interfaces have unexported
// methods, so the concrete types cannot be inspected; the registry remembers the pointers instead.
type recorder struct {
	agents  map[agent.Agent]node
	tools   map[tool.Tool]bool
	models  map[*llm.LLM]bool
	pausing bool
	// capabilityTools excludes control tools such as ExitLoop from fixed toolsets.
	capabilityTools map[tool.Tool]bool
	toolsets        map[*fixedToolset]bool
	// longRunning holds the tools that run before they pause.
	longRunning map[tool.Tool]bool
}

var (
	buildMu sync.Mutex
	current *recorder
)

func record(build func() (agent.Agent, error)) (agent.Agent, *recorder, error) {
	buildMu.Lock()
	defer buildMu.Unlock()
	current = &recorder{
		agents:          map[agent.Agent]node{},
		tools:           map[tool.Tool]bool{},
		models:          map[*llm.LLM]bool{},
		longRunning:     map[tool.Tool]bool{},
		capabilityTools: map[tool.Tool]bool{},
		toolsets:        map[*fixedToolset]bool{},
	}
	defer func() { current = nil }()
	root, err := build()
	if err != nil {
		return nil, nil, llm.NewError("unsupported")
	}
	if err := current.validate(root); err != nil {
		return nil, nil, err
	}
	return root, current, nil
}

func (r *recorder) validate(root agent.Agent) error {
	if root == nil {
		return llm.NewError("unsupported")
	}
	return r.walk(root, map[agent.Agent]bool{}, 1)
}

func (r *recorder) walk(current agent.Agent, path map[agent.Agent]bool, depth int) error {
	info, known := r.agents[current]
	if !known || depth > maxDepth || path[current] {
		return llm.NewError("unsupported")
	}
	if info.model != nil && !r.models[info.model] {
		return llm.NewError("unsupported")
	}
	for _, each := range info.tools {
		if !r.tools[each] {
			return llm.NewError("unsupported")
		}
	}
	path[current] = true
	defer delete(path, current)
	for _, child := range current.SubAgents() {
		if err := r.walk(child, path, depth+1); err != nil {
			return err
		}
	}
	return nil
}

func active() *recorder { return current }
