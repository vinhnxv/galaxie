// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/tool"
	"google.golang.org/adk/tool/geminitool"

	"galaxie.invalid/galaxie/galaxie/llm"
)

// T-go ALTERNATIVE. Test-local registered fixed expansion passes GT1-GT3;
// GT5 fails because no public toolset constructor exists. AL-T is a static
// capability list with matching native script/schema evidence in the external
// file. GT4 uses registry membership; no network toolset connects.
type registeredShapeTools struct{ fixed []tool.Tool }

func (*registeredShapeTools) Name() string        { return "fixed" }
func (*registeredShapeTools) Description() string { return "Fixed capability tools." }
func (*registeredShapeTools) IsLongRunning() bool { return false }
func (s *registeredShapeTools) Tools(agent.ReadonlyContext) ([]tool.Tool, error) {
	return append([]tool.Tool(nil), s.fixed...), nil
}

func expandShapeTools(r *recorder, set *registeredShapeTools) ([]tool.Tool, error) {
	if !r.tools[set] {
		return nil, llm.NewError("unsupported")
	}
	for _, each := range set.fixed {
		if !r.tools[each] {
			return nil, llm.NewError("unsupported")
		}
	}
	return append([]tool.Tool(nil), set.fixed...), nil
}
func shapeListEntry(grouped bool, badPosition bool) Entry {
	return func() (agent.Agent, error) {
		gated, err := CapabilityTool("math.double@1", ToolSpec{Description: "Double.", Schema: schema, RequireConfirmation: true})
		if err != nil {
			return nil, err
		}
		tools := []tool.Tool{gated}
		if grouped {
			set := &registeredShapeTools{fixed: append([]tool.Tool(nil), tools...)}
			r := active()
			r.tools[set] = true
			defer delete(r.tools, set)
			tools, err = expandShapeTools(r, set)
			if err != nil {
				return nil, err
			}
		}
		root, err := LlmAgent(llmagent.Config{Name: "root", Model: Model("answer"), Tools: tools})
		if err != nil {
			return nil, err
		}
		if badPosition {
			return ParallelAgent(agent.Config{Name: "parallel", SubAgents: []agent.Agent{root}})
		}
		return root, nil
	}
}

type shapeListCaller struct {
	models []llm.ModelRequest
	calls  []llm.CapabilityRequest
}

func (c *shapeListCaller) Call(_ context.Context, op string, payload []byte) ([]byte, error) {
	if op == "model" {
		var request llm.ModelRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, err
		}
		c.models = append(c.models, request)
		if len(c.models) == 1 {
			return []byte(doubleCall), nil
		}
		return []byte(text("done")), nil
	}
	if op == "capability" {
		var request llm.CapabilityRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, err
		}
		c.calls = append(c.calls, request)
		return []byte(`{"value":6}`), nil
	}
	return nil, llm.NewError("unsupported")
}
func shapeListDefinition(grouped, badPosition bool) Definition {
	return Definition{Build: shapeListEntry(grouped, badPosition), Interaction: func([]Request) (map[string]any, error) {
		return map[string]any{"surfaceId": "s", "viewRevision": "1", "component": "c/v1", "props": map[string]any{}}, nil
	}}
}

func TestToolsetFixedExpansionMatchesConfirmedFlatListAndEffectScope(t *testing.T) {
	var previous *shapeListCaller
	var previousID string
	for _, grouped := range []bool{false, true} {
		caller := &shapeListCaller{}
		store := NewStore()
		definition := shapeListDefinition(grouped, false)
		paused, err := store.Run(context.Background(), caller, definition, Input{Prompt: "question", Conversation: "c"})
		if err != nil || paused.Pause == nil || len(caller.calls) != 0 {
			t.Fatalf("pause=%+v err=%v", paused, err)
		}
		done, err := store.Run(context.Background(), caller, definition, Input{Conversation: "c", Resume: &Resumption{InteractionID: paused.Pause.ID, Action: "approve", Payload: approve()}})
		if err != nil || done.Output != "done" || len(caller.calls) != 1 {
			t.Fatalf("done=%+v calls=%v err=%v", done, caller.calls, err)
		}
		if caller.calls[0].EffectScope != "adk-go/c/root/1/0" {
			t.Fatalf("scope=%q", caller.calls[0].EffectScope)
		}
		if previous != nil && (!reflect.DeepEqual(previous, caller) || previousID != paused.Pause.ID) {
			t.Fatal("fixed expansion changed requests, effects or interaction identity")
		}
		previous, previousID = caller, paused.Pause.ID
	}
}

func TestToolsetFixedExpansionCannotHideAnUnsupportedPausePosition(t *testing.T) {
	caller := &shapeListCaller{}
	_, err := NewStore().Run(context.Background(), caller, shapeListDefinition(true, true), Input{Prompt: "question", Conversation: "c"})
	var failure *llm.Error
	if !errors.As(err, &failure) || failure.Code != "unsupported" || len(caller.calls) != 0 {
		t.Fatalf("err=%v calls=%v", err, caller.calls)
	}
}

func TestToolsetFixedExpansionRefusesUnregisteredAndForeignContents(t *testing.T) {
	for _, foreign := range []bool{false, true} {
		_, _, err := record(func() (agent.Agent, error) {
			set := &registeredShapeTools{fixed: []tool.Tool{geminitool.GoogleSearch{}}}
			if foreign {
				active().tools[set] = true
				defer delete(active().tools, set)
			}
			_, err := expandShapeTools(active(), set)
			return nil, err
		})
		if err == nil {
			t.Fatal("foreign toolset was admitted")
		}
	}
}
