// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/tool"

	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

func calls(pairs ...string) string {
	type call struct {
		ID       string `json:"id"`
		Type     string `json:"type"`
		Function struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"function"`
	}
	var list []call
	for index := 0; index < len(pairs); index += 2 {
		item := call{ID: "p" + string(rune('a'+index/2)), Type: "function"}
		item.Function.Name = pairs[index]
		item.Function.Arguments = pairs[index+1]
		list = append(list, item)
	}
	encoded, _ := json.Marshal(map[string]any{"content": "", "toolCalls": list})
	return string(encoded)
}

func show(requests []galaxie.Request) (map[string]any, error) {
	items := make([]any, len(requests))
	for index, request := range requests {
		items[index] = map[string]any{"kind": request.Kind, "tool": request.Tool, "args": request.Args, "hint": request.Hint}
	}
	return map[string]any{
		"surfaceId":    "tool.Confirm",
		"viewRevision": "1",
		"component":    "tool.Confirm/v1",
		"props":        map[string]any{"requests": items},
	}, nil
}

func definitionOf(build galaxie.Entry) galaxie.Definition {
	return galaxie.Definition{Build: build, Interaction: show}
}

func pausingTool(capability string, confirm, longRunning bool) (tool.Tool, error) {
	return galaxie.CapabilityTool(capability, galaxie.ToolSpec{
		Description:         "Double an integer.",
		Schema:              doubleSchema,
		RequireConfirmation: confirm,
		LongRunning:         longRunning,
	})
}

// gate builds a leaf agent whose tools are the confirmation tool "math.double@1", the plain tool
// "math.triple@1" and the long-running tool "job.start@1".
func gate(name string) (agent.Agent, error) {
	double, err := pausingTool("math.double@1", true, false)
	if err != nil {
		return nil, err
	}
	triple, err := pausingTool("math.triple@1", false, false)
	if err != nil {
		return nil, err
	}
	job, err := pausingTool("job.start@1", false, true)
	if err != nil {
		return nil, err
	}
	return galaxie.LlmAgent(llmagent.Config{
		Name:        name,
		Model:       galaxie.Model("answer"),
		Instruction: "Use the tools.",
		Tools:       []tool.Tool{double, triple, job},
	})
}

func gateEntry() (agent.Agent, error) { return gate("agent") }

func reply(text string) string {
	encoded, _ := json.Marshal(map[string]any{"content": text})
	return string(encoded)
}

func approveAll(count int) any {
	indexes := make([]any, count)
	for index := range indexes {
		indexes[index] = float64(index)
	}
	return map[string]any{"indexes": indexes}
}

func echoCapability(request llm.CapabilityRequest) (string, error) {
	return `{"value":` + `6}`, nil
}

func start(t *testing.T, store *galaxie.Store, caller *scripted, definition galaxie.Definition) galaxie.Result {
	t.Helper()
	result, err := store.Run(context.Background(), caller, definition, galaxie.Input{Prompt: "go", Conversation: "c"})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func answer(store *galaxie.Store, caller *scripted, definition galaxie.Definition, id, action string, payload any) (galaxie.Result, error) {
	return store.Run(context.Background(), caller, definition, galaxie.Input{
		Conversation: "c",
		Resume:       &galaxie.Resumption{InteractionID: id, Action: action, Payload: payload},
	})
}

func TestAnApprovedConfirmationRunsTheToolAfterTheAnswer(t *testing.T) {
	caller := &scripted{
		replies:    []string{calls("math_double_1", `{"value":3}`), reply("It is 6.")},
		capability: echoCapability,
	}
	store := galaxie.NewStore()
	definition := definitionOf(gateEntry)
	paused := start(t, store, caller, definition)
	if paused.Pause == nil || len(paused.Pause.Tools) != 1 || paused.Pause.Tools[0] != "math_double_1" {
		t.Fatalf("result = %+v", paused)
	}
	if len(caller.calls) != 0 {
		t.Fatalf("the tool ran before the approval: %+v", caller.calls)
	}
	done, err := answer(store, caller, definition, paused.Pause.ID, "approve", approveAll(1))
	if err != nil || done.Output != "It is 6." {
		t.Fatalf("result = %+v, err = %v", done, err)
	}
	if len(caller.calls) != 1 || caller.calls[0].Name != "math.double@1" {
		t.Fatalf("calls = %+v", caller.calls)
	}
	if scope := caller.calls[0].EffectScope; scope != "adk-go/c/root/1/0" {
		t.Fatalf("the resumed call lost its scope: %q", scope)
	}
}

func TestADeclinedConfirmationNeverRunsTheToolAndTheModelSeesTheRejection(t *testing.T) {
	caller := &scripted{
		replies:    []string{calls("math_double_1", `{"value":3}`), reply("Declined.")},
		capability: echoCapability,
	}
	store := galaxie.NewStore()
	definition := definitionOf(gateEntry)
	paused := start(t, store, caller, definition)
	done, err := answer(store, caller, definition, paused.Pause.ID, "deny", approveAll(1))
	if err != nil || done.Output != "Declined." || len(caller.calls) != 0 {
		t.Fatalf("result = %+v, err = %v, calls = %+v", done, err, caller.calls)
	}
	last := caller.models[len(caller.models)-1].Messages
	if encoded, _ := json.Marshal(last[len(last)-1]); !strings.Contains(string(encoded), "rejected") {
		t.Fatalf("the model was not told the call was rejected: %s", encoded)
	}
}

func values(caller *scripted) []float64 {
	var found []float64
	for _, call := range caller.calls {
		found = append(found, call.Input["value"].(float64))
	}
	slices.Sort(found)
	return found
}

func TestTwoConfirmationsInOneResponseFormOneInteractionAnsweredTogether(t *testing.T) {
	caller := &scripted{
		replies:    []string{calls("math_double_1", `{"value":1}`, "math_double_1", `{"value":2}`), reply("Both.")},
		capability: echoCapability,
	}
	store := galaxie.NewStore()
	definition := definitionOf(gateEntry)
	paused := start(t, store, caller, definition)
	if len(paused.Pause.Tools) != 2 {
		t.Fatalf("tools = %v", paused.Pause.Tools)
	}
	done, err := answer(store, caller, definition, paused.Pause.ID, "approve", approveAll(2))
	// The sibling tools of one turn run on separate goroutines, so only the set of calls is stable.
	if err != nil || done.Output != "Both." || !slices.Equal(values(caller), []float64{1, 2}) {
		t.Fatalf("result = %+v, err = %v, values = %v", done, err, values(caller))
	}
}

func TestAConfirmationBesideAPlainCallRunsThePlainCallOnceAndHoldsTheOther(t *testing.T) {
	caller := &scripted{
		replies:    []string{calls("math_double_1", `{"value":1}`, "math_triple_1", `{"value":2}`), reply("Both.")},
		capability: echoCapability,
	}
	store := galaxie.NewStore()
	definition := definitionOf(gateEntry)
	paused := start(t, store, caller, definition)
	if len(caller.calls) != 1 || caller.calls[0].Name != "math.triple@1" || len(paused.Pause.Tools) != 1 {
		t.Fatalf("calls = %+v, tools = %v", caller.calls, paused.Pause.Tools)
	}
	done, err := answer(store, caller, definition, paused.Pause.ID, "approve", approveAll(1))
	if err != nil || done.Output != "Both." || len(caller.calls) != 2 {
		t.Fatalf("result = %+v, err = %v, calls = %+v", done, err, caller.calls)
	}
	tools := 0
	for _, message := range caller.models[1].Messages {
		if message.Role == "tool" {
			tools++
		}
	}
	if tools != 2 {
		t.Fatalf("the model saw %d tool results", tools)
	}
}

func TestAConfirmationBesideALongRunningCallIsRefused(t *testing.T) {
	caller := &scripted{
		replies:    []string{calls("math_double_1", `{"value":1}`, "job_start_1", `{"value":2}`), reply("never")},
		capability: echoCapability,
	}
	_, err := galaxie.NewStore().Run(context.Background(), caller, definitionOf(gateEntry), galaxie.Input{Prompt: "go", Conversation: "c"})
	assertCode(t, err, "unsupported")
	if len(caller.models) != 1 {
		t.Fatalf("the model was asked %d times", len(caller.models))
	}
}

func assertCode(t *testing.T, err error, code string) {
	t.Helper()
	var failure *llm.Error
	if !errors.As(err, &failure) || failure.Code != code {
		t.Fatalf("err = %v, want %s", err, code)
	}
}

func TestALongRunningToolPausesWithItsPendingResultAndTheAnswerIsTheRealResult(t *testing.T) {
	caller := &scripted{
		replies:    []string{calls("job_start_1", `{"value":1}`), reply("Finished.")},
		capability: func(llm.CapabilityRequest) (string, error) { return `{"status":"pending"}`, nil },
	}
	store := galaxie.NewStore()
	definition := definitionOf(gateEntry)
	definition.Resume = func(requests []galaxie.Request, action string, payload any) ([]galaxie.Decision, error) {
		if len(requests) != 1 || requests[0].Kind != galaxie.KindLongRunning || action != "done" {
			return nil, llm.NewError("invalid")
		}
		return []galaxie.Decision{galaxie.Respond(payload.(map[string]any))}, nil
	}
	paused := start(t, store, caller, definition)
	if len(caller.models) != 1 {
		t.Fatalf("the model was asked about the pending result: %d", len(caller.models))
	}
	done, err := answer(store, caller, definition, paused.Pause.ID, "done", map[string]any{"value": float64(42)})
	if err != nil || done.Output != "Finished." || len(caller.calls) != 1 {
		t.Fatalf("result = %+v, err = %v, calls = %+v", done, err, caller.calls)
	}
	tool := caller.models[1].Messages[len(caller.models[1].Messages)-1]
	if tool.Role != "tool" || tool.Content != `{"value":42}` {
		t.Fatalf("tool message = %+v", tool)
	}
}

func TestAnAnswerNeedsTheIdOfThePauseItAnswers(t *testing.T) {
	caller := &scripted{replies: []string{calls("math_double_1", `{"value":1}`), reply("ok")}, capability: echoCapability}
	store := galaxie.NewStore()
	definition := definitionOf(gateEntry)
	paused := start(t, store, caller, definition)
	_, err := answer(store, caller, definition, "0000", "approve", approveAll(1))
	assertCode(t, err, "stale")
	// A wrong ID does not consume the pause.
	if _, err := answer(store, caller, definition, paused.Pause.ID, "approve", approveAll(1)); err != nil {
		t.Fatal(err)
	}
	_, err = answer(store, caller, definition, paused.Pause.ID, "approve", approveAll(1))
	assertCode(t, err, "stale")
}

func TestAnInvalidAnswerConsumesThePauseAndNeverRunsTheTool(t *testing.T) {
	bad := []struct {
		name    string
		action  string
		payload any
	}{
		{"unknown action", "maybe", approveAll(2)},
		{"missing index", "approve", approveAll(1)},
		{"repeated index", "approve", map[string]any{"indexes": []any{float64(0), float64(0)}}},
		{"index out of range", "approve", map[string]any{"indexes": []any{float64(0), float64(2)}}},
		{"fractional index", "approve", map[string]any{"indexes": []any{float64(0), 1.5}}},
		{"extra field", "approve", map[string]any{"indexes": []any{float64(0), float64(1)}, "note": "x"}},
		{"no payload", "approve", nil},
		{"payload is not an object", "approve", []any{float64(0), float64(1)}},
		{"indexes is not a list", "approve", map[string]any{"indexes": "01"}},
	}
	for _, each := range bad {
		t.Run(each.name, func(t *testing.T) {
			caller := &scripted{
				replies:    []string{calls("math_double_1", `{"value":1}`, "math_double_1", `{"value":2}`), reply("never")},
				capability: echoCapability,
			}
			store := galaxie.NewStore()
			definition := definitionOf(gateEntry)
			paused := start(t, store, caller, definition)
			_, err := answer(store, caller, definition, paused.Pause.ID, each.action, each.payload)
			assertCode(t, err, "invalid")
			if len(caller.calls) != 0 {
				t.Fatalf("a tool ran: %+v", caller.calls)
			}
			_, err = answer(store, caller, definition, paused.Pause.ID, "approve", approveAll(2))
			assertCode(t, err, "stale")
		})
	}
}

func TestTheDefaultAnswerRefusesALongRunningRequest(t *testing.T) {
	caller := &scripted{
		replies:    []string{calls("job_start_1", `{"value":1}`), reply("never")},
		capability: func(llm.CapabilityRequest) (string, error) { return `{"status":"pending"}`, nil },
	}
	store := galaxie.NewStore()
	definition := definitionOf(gateEntry)
	paused := start(t, store, caller, definition)
	_, err := answer(store, caller, definition, paused.Pause.ID, "approve", approveAll(1))
	assertCode(t, err, "invalid")
}

func TestAHookDecisionOfTheWrongKindIsInvalid(t *testing.T) {
	caller := &scripted{replies: []string{calls("math_double_1", `{"value":1}`), reply("never")}, capability: echoCapability}
	store := galaxie.NewStore()
	definition := definitionOf(gateEntry)
	definition.Resume = func([]galaxie.Request, string, any) ([]galaxie.Decision, error) {
		return []galaxie.Decision{galaxie.Respond(map[string]any{"value": 1})}, nil
	}
	paused := start(t, store, caller, definition)
	_, err := answer(store, caller, definition, paused.Pause.ID, "approve", nil)
	assertCode(t, err, "invalid")
	if len(caller.calls) != 0 {
		t.Fatalf("a tool ran: %+v", caller.calls)
	}
}

func TestConsecutivePausesOfOneConversationHaveDistinctIds(t *testing.T) {
	ids := map[string]bool{}
	store := galaxie.NewStore()
	definition := definitionOf(gateEntry)
	for round := 0; round < 3; round++ {
		caller := &scripted{replies: []string{calls("math_double_1", `{"value":1}`), reply("ok")}, capability: echoCapability}
		paused := start(t, store, caller, definition)
		if ids[paused.Pause.ID] {
			t.Fatalf("round %d repeated an ID", round)
		}
		ids[paused.Pause.ID] = true
		if _, err := answer(store, caller, definition, paused.Pause.ID, "approve", approveAll(1)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAPauseChainsIntoAnotherPauseWithoutLosingTheConversation(t *testing.T) {
	caller := &scripted{
		replies: []string{
			calls("math_double_1", `{"value":1}`),
			calls("math_double_1", `{"value":2}`),
			reply("Done twice."),
		},
		capability: echoCapability,
	}
	store := galaxie.NewStore()
	definition := definitionOf(gateEntry)
	first := start(t, store, caller, definition)
	second, err := answer(store, caller, definition, first.Pause.ID, "approve", approveAll(1))
	if err != nil || second.Pause == nil || second.Pause.ID == first.Pause.ID {
		t.Fatalf("second = %+v, err = %v", second, err)
	}
	done, err := answer(store, caller, definition, second.Pause.ID, "approve", approveAll(1))
	if err != nil || done.Output != "Done twice." || len(caller.calls) != 2 {
		t.Fatalf("done = %+v, err = %v, calls = %+v", done, err, caller.calls)
	}
	scopes := []string{caller.calls[0].EffectScope, caller.calls[1].EffectScope}
	if scopes[0] == scopes[1] || scopes[0] == "" || scopes[1] == "" {
		t.Fatalf("scopes = %v", scopes)
	}
}

func TestANewPromptDropsThePauseItReplaces(t *testing.T) {
	caller := &scripted{
		replies:    []string{calls("math_double_1", `{"value":1}`), reply("Fresh.")},
		capability: echoCapability,
	}
	store := galaxie.NewStore()
	definition := definitionOf(gateEntry)
	paused := start(t, store, caller, definition)
	fresh := start(t, store, caller, definition)
	if fresh.Output != "Fresh." {
		t.Fatalf("fresh = %+v", fresh)
	}
	_, err := answer(store, caller, definition, paused.Pause.ID, "approve", approveAll(1))
	assertCode(t, err, "stale")
}

func TestAModuleWhoseToolsCanPauseNeedsAnInteractionHook(t *testing.T) {
	caller := &scripted{replies: []string{reply("never")}, capability: echoCapability}
	_, err := galaxie.NewStore().Run(context.Background(), caller, galaxie.Definition{Build: gateEntry}, galaxie.Input{Prompt: "go", Conversation: "c"})
	assertCode(t, err, "unsupported")
	if len(caller.models) != 0 {
		t.Fatalf("the model was asked before the refusal")
	}
	_, err = galaxie.Execute(context.Background(), caller, gateEntry, galaxie.Input{Prompt: "go", Conversation: "c"})
	assertCode(t, err, "unsupported")
}

func TestAnInteractionHookThatFailsRefusesThePause(t *testing.T) {
	caller := &scripted{replies: []string{calls("math_double_1", `{"value":1}`), reply("never")}, capability: echoCapability}
	definition := galaxie.Definition{Build: gateEntry, Interaction: func([]galaxie.Request) (map[string]any, error) {
		return nil, errors.New("no surface")
	}}
	_, err := galaxie.NewStore().Run(context.Background(), caller, definition, galaxie.Input{Prompt: "go", Conversation: "c"})
	assertCode(t, err, "unsupported")
}

func TestAResumedRunThatFailsLeavesNothingToAnswerAgain(t *testing.T) {
	caller := &scripted{replies: []string{calls("math_double_1", `{"value":1}`)}, capability: echoCapability}
	store := galaxie.NewStore()
	definition := definitionOf(gateEntry)
	paused := start(t, store, caller, definition)
	// The script has no second reply, so the model fails "unavailable" after the tool ran.
	_, err := answer(store, caller, definition, paused.Pause.ID, "approve", approveAll(1))
	assertCode(t, err, "unavailable")
	_, err = answer(store, caller, definition, paused.Pause.ID, "approve", approveAll(1))
	assertCode(t, err, "stale")
}

func TestThePausedRequestsReachTheHookByPositionWithoutCallIdentifiers(t *testing.T) {
	caller := &scripted{
		replies:    []string{calls("math_double_1", `{"value":1}`, "math_triple_1", `{"value":2}`, "math_double_1", `{"value":3}`), reply("never")},
		capability: echoCapability,
	}
	var seen []galaxie.Request
	definition := galaxie.Definition{Build: gateEntry, Interaction: func(requests []galaxie.Request) (map[string]any, error) {
		seen = requests
		return show(requests)
	}}
	if result := start(t, galaxie.NewStore(), caller, definition); result.Pause == nil {
		t.Fatal("the run did not pause")
	}
	encoded, _ := json.Marshal(seen)
	if len(seen) != 2 || seen[0].Args["value"] != float64(1) || seen[1].Args["value"] != float64(3) ||
		seen[0].Kind != galaxie.KindConfirmation || seen[0].Tool != "math_double_1" ||
		strings.Contains(string(encoded), "adk-") || strings.Contains(string(encoded), "adk_request") {
		t.Fatalf("requests = %s", encoded)
	}
}
