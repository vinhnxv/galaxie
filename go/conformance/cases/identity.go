// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package cases

import (
	"fmt"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"

	"galaxie.invalid/galaxie/galaxie"
)

// IdentityDefinitions adds uniquely named trees used only by the dedicated engine measurements.
// Definitions remains the unchanged set consumed by the golden recorder.
func IdentityDefinitions() map[string]galaxie.Definition {
	plain := map[string]galaxie.Entry{
		"identity-loop-nested": func() (agent.Agent, error) {
			worker, err := leaf("worker")
			if err != nil {
				return nil, err
			}
			loop, err := galaxie.LoopAgent(agent.Config{Name: "loop", SubAgents: []agent.Agent{worker}}, 2)
			if err != nil {
				return nil, err
			}
			return galaxie.SequentialAgent(agent.Config{Name: "tree", SubAgents: []agent.Agent{loop}})
		},
		"identity-sequence-in-sequence": identitySequence("tree", identityLeaf("first"), identitySequence("inner", identityLeaf("mid"), identityLeaf("deep"))),
		"identity-transfer-below-nested": identitySequence("tree", identityLeaf("first"), identitySequence("inner", identityLeaf("mid"), func() (agent.Agent, error) {
			helper, err := leaf("helper")
			if err != nil {
				return nil, err
			}
			return galaxie.LlmAgent(llmagent.Config{Name: "router", Model: galaxie.Model("answer"), SubAgents: []agent.Agent{helper}})
		})),
		"identity-chain-16": identityChain(),
		"identity-parallel-nested": func() (agent.Agent, error) {
			sequence, err := identitySequence("sequence", identityLeaf("a"), identityLeaf("b"))()
			if err != nil {
				return nil, err
			}
			c, err := leaf("c")
			if err != nil {
				return nil, err
			}
			return galaxie.ParallelAgent(agent.Config{Name: "tree", SubAgents: []agent.Agent{sequence, c}})
		},
	}
	definitions := make(map[string]galaxie.Definition, len(plain)+1)
	for name, entry := range plain {
		definitions[name] = galaxie.Definition{Build: entry}
	}
	definitions["identity-pause-nested-last"] = galaxie.Definition{
		Build: identitySequence("tree", identityLeaf("first"), identitySequence("inner", identityLeaf("mid"), func() (agent.Agent, error) {
			return pausing("deep", true, false)
		})),
		Interaction: approval,
	}
	return definitions
}

func identityLeaf(name string) galaxie.Entry {
	return func() (agent.Agent, error) { return leaf(name) }
}

func identitySequence(name string, entries ...galaxie.Entry) galaxie.Entry {
	return func() (agent.Agent, error) {
		children := make([]agent.Agent, 0, len(entries))
		for _, entry := range entries {
			child, err := entry()
			if err != nil {
				return nil, err
			}
			children = append(children, child)
		}
		return galaxie.SequentialAgent(agent.Config{Name: name, SubAgents: children})
	}
}

func identityChain() galaxie.Entry {
	entry := identityLeaf("leaf16")
	for level := 15; level >= 1; level-- {
		entry = identitySequence(fmt.Sprintf("level%d", level), identityLeaf(fmt.Sprintf("leaf%d", level)), entry)
	}
	return entry
}
