// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie_test

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/tool"

	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

type completedRestoreCaller struct{ models int }

func (c *completedRestoreCaller) Call(_ context.Context, op string, _ []byte) ([]byte, error) {
	if op == "capability" {
		return []byte(`{"value":2}`), nil
	}
	if op != "model" {
		return nil, llm.NewError("unsupported")
	}
	c.models++
	if c.models == 1 {
		return []byte(`{"content":"","toolCalls":[{"id":"provider","type":"function","function":{"name":"math_double_1","arguments":"{\"value\":1}"}}]}`), nil
	}
	return []byte(`{"content":"done"}`), nil
}

// The wrapper assessment exposed an existing completed-restore counter reset. This independent
// control keeps the observation executable without retaining the refused wrapper candidate.
func TestCompletedRestoreReusesCallIDsWhileEffectScopesAdvance(t *testing.T) {
	entry := func() (agent.Agent, error) {
		double, err := galaxie.CapabilityTool("math.double@1", galaxie.ToolSpec{Description: "Double.", Schema: `{"type":"object","properties":{"value":{"type":"integer"}},"required":["value"]}`})
		if err != nil {
			return nil, err
		}
		return galaxie.LlmAgent(llmagent.Config{Name: "plain", Model: galaxie.Model("answer"), Tools: []tool.Tool{double}})
	}
	var restore []byte
	var ids []string
	var scopes []string
	for turn := 0; turn < 2; turn++ {
		result, err := galaxie.NewStore().Run(context.Background(), &completedRestoreCaller{}, galaxie.Definition{Build: entry}, galaxie.Input{Prompt: "go", Conversation: "completed-control", Persist: true, Restore: restore})
		if err != nil {
			t.Fatal(err)
		}
		var record struct {
			Memory llm.MemoryState `json:"memory"`
		}
		if err := json.Unmarshal(result.Record, &record); err != nil {
			t.Fatal(err)
		}
		if len(record.Memory.Scopes) != 1 {
			t.Fatalf("scopes=%v", record.Memory.Scopes)
		}
		for id, scope := range record.Memory.Scopes {
			ids = append(ids, id)
			scopes = append(scopes, scope)
		}
		restore = result.Record
	}
	if ids[0] != ids[1] {
		t.Fatalf("completed-restore ID behavior changed: %v; rerun wrapper assessment", ids)
	}
	if !reflect.DeepEqual(scopes, []string{"adk-go/completed-control/root/1/0", "adk-go/completed-control/root/2/0"}) {
		t.Fatalf("scopes=%v", scopes)
	}
	t.Logf("completed restore reuses %q across distinct scopes %v", ids[0], scopes)
}
