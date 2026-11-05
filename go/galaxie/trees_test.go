// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/tool"

	"galaxie.invalid/galaxie/galaxie/llm"
)

// These tests record what ADK Go v1.9.0 does with a pause that is NOT refused, which is why the
// tree rule exists: a resume continues only the agent that paused.

type roleCaller struct {
	mu      sync.Mutex
	replies map[string][]string
	asked   []string
}

func (c *roleCaller) Call(_ context.Context, op string, payload []byte) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if op == "capability" {
		return []byte(`{"value":6}`), nil
	}
	var request llm.ModelRequest
	if err := json.Unmarshal(payload, &request); err != nil {
		return nil, err
	}
	system := request.Messages[0].Content
	name := system[strings.Index(system, `"`)+1:]
	name = name[:strings.Index(name, `"`)]
	c.asked = append(c.asked, name)
	queue := c.replies[name]
	if len(queue) == 0 {
		return nil, llm.NewError("unavailable")
	}
	c.replies[name] = queue[1:]
	return []byte(queue[0]), nil
}

func (c *roleCaller) count(name string) int {
	total := 0
	for _, each := range c.asked {
		if each == name {
			total++
		}
	}
	return total
}

const (
	doubleCall = `{"content":"","toolCalls":[{"id":"p","type":"function","function":{"name":"math_double_1","arguments":"{\"value\":1}"}}]}`
	schema     = `{"type":"object","properties":{"value":{"type":"integer"}},"required":["value"]}`
)

func text(value string) string {
	encoded, _ := json.Marshal(map[string]any{"content": value})
	return string(encoded)
}

func gated(name string) (agent.Agent, error) {
	double, err := CapabilityTool("math.double@1", ToolSpec{Description: "Double.", Schema: schema, RequireConfirmation: true})
	if err != nil {
		return nil, err
	}
	return LlmAgent(llmagent.Config{
		Name:        name,
		Model:       Model("answer"),
		Instruction: "Use the tool.",
		Tools:       []tool.Tool{double},
	})
}

func tree(kind string) Entry {
	return func() (agent.Agent, error) {
		first, err := gated("first")
		if err != nil {
			return nil, err
		}
		second, err := LlmAgent(llmagent.Config{Name: "second", Model: Model("answer"), Instruction: "Finish."})
		if err != nil {
			return nil, err
		}
		children := []agent.Config{{Name: "tree", SubAgents: []agent.Agent{first, second}}}
		switch kind {
		case "sequential-first":
			return SequentialAgent(children[0])
		case "sequential-last":
			children[0].SubAgents = []agent.Agent{second, first}
			return SequentialAgent(children[0])
		case "parallel":
			return ParallelAgent(children[0])
		default:
			return LoopAgent(children[0], 2)
		}
	}
}

func approve() any { return map[string]any{"indexes": []any{float64(0)}} }

// run pauses the tree (the rule lifted), answers it and reports which agents the model served.
func run(t *testing.T, kind string, replies map[string][]string) (*roleCaller, Result) {
	t.Helper()
	caller := &roleCaller{replies: replies}
	store := NewStore()
	store.lossyPauses = true
	definition := Definition{Build: tree(kind), Interaction: func([]Request) (map[string]any, error) {
		return map[string]any{"surfaceId": "s", "viewRevision": "1", "component": "c/v1", "props": map[string]any{}}, nil
	}}
	paused, err := store.Run(context.Background(), caller, definition, Input{Prompt: "go", Conversation: "c"})
	if err != nil || paused.Pause == nil {
		t.Fatalf("paused = %+v, err = %v", paused, err)
	}
	t.Logf("%s: agents asked before the answer: %v", kind, caller.asked)
	done, err := store.Run(context.Background(), caller, definition, Input{Conversation: "c", Resume: &Resumption{InteractionID: paused.Pause.ID, Action: "approve", Payload: approve()}})
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	t.Logf("%s: agents asked in all: %v, output = %q", kind, caller.asked, done.Output)
	return caller, done
}

func TestAResumeInTheFirstChildOfASequenceNeverRunsTheLaterChildren(t *testing.T) {
	caller, done := run(t, "sequential-first", map[string][]string{
		"first":  {doubleCall, text("first done")},
		"second": {text("second done")},
	})
	if caller.count("second") != 0 || done.Output != "first done" {
		t.Fatalf("the later sibling ran %d times, output = %q", caller.count("second"), done.Output)
	}
}

func TestAResumeInTheLastChildOfASequenceLosesNothing(t *testing.T) {
	caller, done := run(t, "sequential-last", map[string][]string{
		"first":  {doubleCall, text("first done")},
		"second": {text("second done")},
	})
	if caller.count("second") != 1 || caller.count("first") != 2 || done.Output != "first done" {
		t.Fatalf("asked = %v, output = %q", caller.asked, done.Output)
	}
}

func TestAResumeInsideAParallelAgentRunsOnlyTheAgentThatPaused(t *testing.T) {
	caller, done := run(t, "parallel", map[string][]string{
		"first":  {doubleCall, text("first done")},
		"second": {text("second done")},
	})
	if caller.count("second") != 1 || caller.count("first") != 2 {
		t.Fatalf("asked = %v, output = %q", caller.asked, done.Output)
	}
}

func TestAResumeInsideALoopDoesNotIterateAgain(t *testing.T) {
	caller, done := run(t, "loop", map[string][]string{
		"first":  {doubleCall, text("first done")},
		"second": {text("second done"), text("again")},
	})
	t.Logf("asked = %v, output = %q", caller.asked, done.Output)
	if caller.count("first") != 2 || caller.count("second") != 0 {
		t.Fatalf("asked = %v", caller.asked)
	}
}
