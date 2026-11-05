// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie_test

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

func persisted(t *testing.T, store *galaxie.Store, caller *scripted, definition galaxie.Definition, input galaxie.Input) galaxie.Result {
	t.Helper()
	input.Persist = true
	if input.Conversation == "" {
		input.Conversation = "c"
	}
	result, err := store.Run(context.Background(), caller, definition, input)
	if err != nil {
		t.Fatal(err)
	}
	if result.Record == nil {
		t.Fatalf("no record: %+v", result)
	}
	return result
}

func resumeFrom(record []byte, id, action string, payload any) galaxie.Input {
	return galaxie.Input{
		Conversation: "c",
		Restore:      record,
		Resume:       &galaxie.Resumption{InteractionID: id, Action: action, Payload: payload},
	}
}

// edit decodes a record, lets the change modify it and encodes it again.
func edit(t *testing.T, record []byte, change func(map[string]any)) []byte {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(record, &value); err != nil {
		t.Fatal(err)
	}
	change(value)
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestAPausedConversationRestoresInAFreshStoreAndContinuesLikeTheLiveOne(t *testing.T) {
	replies := []string{calls("math_double_1", `{"value":3}`), reply("It is 6.")}
	live := &scripted{replies: slicesClone(replies), capability: echoCapability}
	liveStore := galaxie.NewStore()
	definition := definitionOf(gateEntry)
	paused := start(t, liveStore, live, definition)
	if _, err := answer(liveStore, live, definition, paused.Pause.ID, "approve", approveAll(1)); err != nil {
		t.Fatal(err)
	}

	restoredCaller := &scripted{replies: slicesClone(replies), capability: echoCapability}
	pausedAgain := persisted(t, galaxie.NewStore(), restoredCaller, definition, galaxie.Input{Prompt: "go"})
	if pausedAgain.Pause == nil || pausedAgain.Pause.ID != paused.Pause.ID {
		t.Fatalf("the interaction id changed: %+v", pausedAgain.Pause)
	}
	if !reflect.DeepEqual(pausedAgain.Pause.Request, paused.Pause.Request) {
		t.Fatalf("request = %+v", pausedAgain.Pause.Request)
	}
	// A different store stands in for a Worker that started after the reload.
	done := persisted(t, galaxie.NewStore(), restoredCaller, definition, resumeFrom(pausedAgain.Record, paused.Pause.ID, "approve", approveAll(1)))
	if done.Output != "It is 6." || done.Pause != nil {
		t.Fatalf("result = %+v", done)
	}
	if !reflect.DeepEqual(live.models, restoredCaller.models) || !reflect.DeepEqual(live.calls, restoredCaller.calls) {
		t.Fatalf("the restored conversation diverged\nlive: %+v\nrestored: %+v", live.models, restoredCaller.models)
	}
	if scope := restoredCaller.calls[0].EffectScope; scope != "adk-go/c/root/1/0" {
		t.Fatalf("the resumed call lost its scope: %q", scope)
	}
	var completed struct {
		Pause  any `json:"pause"`
		Events []any
	}
	if err := json.Unmarshal(done.Record, &completed); err != nil || completed.Pause != nil || len(completed.Events) == 0 {
		t.Fatalf("completion record = %s, err = %v", done.Record, err)
	}
}

func slicesClone(values []string) []string { return append([]string(nil), values...) }

func TestAPersistedStoreKeepsNothingAndAStaleAnswerFails(t *testing.T) {
	caller := &scripted{replies: []string{calls("math_double_1", `{"value":3}`)}, capability: echoCapability}
	store := galaxie.NewStore()
	definition := definitionOf(gateEntry)
	paused := persisted(t, store, caller, definition, galaxie.Input{Prompt: "go"})
	// The store did not keep the session: only the record can answer the pause.
	_, err := answer(store, caller, definition, paused.Pause.ID, "approve", approveAll(1))
	assertCode(t, err, "stale")
	_, err = store.Run(context.Background(), caller, definition, resumeFrom(paused.Record, strings.Repeat("0", 64), "approve", approveAll(1)))
	assertCode(t, err, "stale")
	if len(caller.calls) != 0 {
		t.Fatalf("a stale answer ran a tool: %+v", caller.calls)
	}
}

func TestANewConversationAfterARestoreNeverRepeatsAStoredEffectScope(t *testing.T) {
	definition := definitionOf(gateEntry)
	first := &scripted{replies: []string{calls("math_triple_1", `{"value":1}`), reply("One.")}, capability: echoCapability}
	done := persisted(t, galaxie.NewStore(), first, definition, galaxie.Input{Prompt: "one"})
	second := &scripted{replies: []string{calls("math_triple_1", `{"value":2}`), reply("Two.")}, capability: echoCapability}
	// A fresh store, as after a reload, continues from the stored counters.
	again := persisted(t, galaxie.NewStore(), second, definition, galaxie.Input{Prompt: "two", Restore: done.Record})
	if again.Output != "Two." {
		t.Fatalf("result = %+v", again)
	}
	if first.calls[0].EffectScope != "adk-go/c/root/1/0" || second.calls[0].EffectScope != "adk-go/c/root/2/0" {
		t.Fatalf("scopes = %q then %q", first.calls[0].EffectScope, second.calls[0].EffectScope)
	}
	var stored struct {
		Events []struct {
			ID string `json:"id"`
		} `json:"events"`
	}
	if err := json.Unmarshal(again.Record, &stored); err != nil || len(stored.Events) == 0 {
		t.Fatal(err)
	}
}

func TestARestoredPauseKeepsItsIdentifiersAcrossAnotherPauseAfterTheAnswer(t *testing.T) {
	definition := definitionOf(gateEntry)
	caller := &scripted{
		replies:    []string{calls("math_double_1", `{"value":1}`), calls("math_double_1", `{"value":2}`), reply("Done.")},
		capability: echoCapability,
	}
	first := persisted(t, galaxie.NewStore(), caller, definition, galaxie.Input{Prompt: "go"})
	second := persisted(t, galaxie.NewStore(), caller, definition, resumeFrom(first.Record, first.Pause.ID, "approve", approveAll(1)))
	if second.Pause == nil || second.Pause.ID == first.Pause.ID {
		t.Fatalf("the second pause reused the first interaction id: %+v", second.Pause)
	}
	done := persisted(t, galaxie.NewStore(), caller, definition, resumeFrom(second.Record, second.Pause.ID, "approve", approveAll(1)))
	if done.Output != "Done." || len(caller.calls) != 2 {
		t.Fatalf("result = %+v, calls = %+v", done, caller.calls)
	}
	if caller.calls[0].EffectScope == caller.calls[1].EffectScope {
		t.Fatalf("scopes repeat: %q", caller.calls[0].EffectScope)
	}
}

func TestAChangedRecordIsRefusedBeforeAnyModelOrToolCall(t *testing.T) {
	definition := definitionOf(gateEntry)
	seed := &scripted{replies: []string{calls("math_double_1", `{"value":3}`)}, capability: echoCapability}
	paused := persisted(t, galaxie.NewStore(), seed, definition, galaxie.Input{Prompt: "go"})
	changes := map[string]func(map[string]any){
		"forged interaction id": func(value map[string]any) {
			value["pause"].(map[string]any)["id"] = strings.Repeat("a", 64)
		},
		"changed request": func(value map[string]any) {
			value["pause"].(map[string]any)["request"].(map[string]any)["component"] = "tool.Other/v1"
		},
		"changed call arguments": func(value map[string]any) {
			calls := value["pause"].(map[string]any)["calls"].([]any)
			calls[0].(map[string]any)["request"].(map[string]any)["args"] = map[string]any{"value": 99}
		},
		"changed confirmation event": func(value map[string]any) {
			for _, event := range value["events"].([]any) {
				content, ok := event.(map[string]any)["content"].(map[string]any)
				if !ok {
					continue
				}
				for _, part := range content["parts"].([]any) {
					call, ok := part.(map[string]any)["functionCall"].(map[string]any)
					if ok && call["name"] == "adk_request_confirmation" {
						call["args"].(map[string]any)["originalFunctionCall"].(map[string]any)["args"] = map[string]any{"value": 99}
					}
				}
			}
		},
		"event without an id": func(value map[string]any) {
			value["events"].([]any)[0].(map[string]any)["id"] = ""
		},
		"unknown field": func(value map[string]any) { value["extra"] = true },
		"other conversation": func(value map[string]any) {
			value["conversation"] = "other"
		},
		"call outside the events": func(value map[string]any) {
			calls := value["pause"].(map[string]any)["calls"].([]any)
			calls[0].(map[string]any)["id"] = "missing"
		},
		"other version": func(value map[string]any) { value["v"] = 2 },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			caller := &scripted{replies: []string{reply("never")}, capability: echoCapability}
			changed := edit(t, paused.Record, change)
			id := paused.Pause.ID
			var named struct {
				Pause struct {
					ID string `json:"id"`
				} `json:"pause"`
			}
			if json.Unmarshal(changed, &named) == nil && named.Pause.ID != "" {
				id = named.Pause.ID
			}
			_, err := galaxie.NewStore().Run(context.Background(), caller, definition, resumeFrom(changed, id, "approve", approveAll(1)))
			assertCode(t, err, "invalid")
			if len(caller.models) != 0 || len(caller.calls) != 0 {
				t.Fatalf("dispatched after a refused record: %d model calls, %d tool calls", len(caller.models), len(caller.calls))
			}
		})
	}
}

func TestArbitraryBytesAreNotARecord(t *testing.T) {
	definition := definitionOf(gateEntry)
	padded := `{"v":1,"pad":"` + strings.Repeat("x", galaxie.MaxRecordBytes) + `"}`
	for _, raw := range []string{`{`, `[]`, `null`, `{"v":1}`, `{"v":1,"conversation":"g1"} {}`, padded, strings.Repeat("x", galaxie.MaxRecordBytes+1)} {
		caller := &scripted{replies: []string{reply("never")}, capability: echoCapability}
		_, err := galaxie.NewStore().Run(context.Background(), caller, definition,
			resumeFrom([]byte(raw), strings.Repeat("a", 64), "approve", approveAll(1)))
		assertCode(t, err, "invalid")
		if len(caller.models) != 0 {
			t.Fatal("dispatched after an unreadable record")
		}
	}
}

// bigResult answers the plain tool with a payload of the given size and every other tool briefly.
func bigResult(size int) func(llm.CapabilityRequest) (string, error) {
	return func(request llm.CapabilityRequest) (string, error) {
		if request.Name != "math.triple@1" {
			return `{"value":6}`, nil
		}
		return `{"value":"` + strings.Repeat("a", size) + `"}`, nil
	}
}

func TestTheLargestPermittedRecordRoundTripsAndGrowthPastTheFrameStopsTheRun(t *testing.T) {
	definition := definitionOf(gateEntry)
	// 470 kB of tool result fits the record; the conversation then pauses and restores.
	fits := &scripted{
		replies:    []string{calls("math_triple_1", `{"value":1}`), calls("math_double_1", `{"value":2}`), reply("Done.")},
		capability: bigResult(470_000),
	}
	paused := persisted(t, galaxie.NewStore(), fits, definition, galaxie.Input{Prompt: "go"})
	if len(paused.Record) > galaxie.MaxRecordBytes || len(paused.Record) < 470_000 {
		t.Fatalf("record size = %d", len(paused.Record))
	}
	done := persisted(t, galaxie.NewStore(), fits, definition, resumeFrom(paused.Record, paused.Pause.ID, "approve", approveAll(1)))
	if done.Output != "Done." {
		t.Fatalf("result = %+v", done)
	}

	// 495 kB crosses the limit: the run fails before the model is asked about the result.
	grows := &scripted{
		replies:    []string{calls("math_triple_1", `{"value":1}`), reply("never")},
		capability: bigResult(495_000),
	}
	_, err := galaxie.NewStore().Run(context.Background(), grows, definition, galaxie.Input{Prompt: "go", Conversation: "c", Persist: true})
	assertCode(t, err, "unsupported")
	if len(grows.models) != 1 {
		t.Fatalf("the model was asked %d times after the limit", len(grows.models))
	}

	// Without a record to write, the same growth is not limited.
	free := &scripted{
		replies:    []string{calls("math_triple_1", `{"value":1}`), reply("Fine.")},
		capability: bigResult(495_000),
	}
	unlimited, err := galaxie.NewStore().Run(context.Background(), free, definition, galaxie.Input{Prompt: "go", Conversation: "c"})
	if err != nil || unlimited.Output != "Fine." {
		t.Fatalf("result = %+v, err = %v", unlimited, err)
	}
}

func TestARecordAlreadyWithinTheMarginIsRefusedBeforeTheNextDispatch(t *testing.T) {
	definition := definitionOf(gateEntry)
	seed := &scripted{replies: []string{calls("math_double_1", `{"value":3}`)}, capability: echoCapability}
	paused := persisted(t, galaxie.NewStore(), seed, definition, galaxie.Input{Prompt: "go"})
	padded := edit(t, paused.Record, func(value map[string]any) {
		first := value["events"].([]any)[0].(map[string]any)["content"].(map[string]any)["parts"].([]any)[0].(map[string]any)
		first["text"] = strings.Repeat("a", 495_000)
	})
	if len(padded) > galaxie.MaxRecordBytes {
		t.Fatalf("padded record = %d", len(padded))
	}
	caller := &scripted{replies: []string{reply("never")}, capability: echoCapability}
	_, err := galaxie.NewStore().Run(context.Background(), caller, definition, resumeFrom(padded, paused.Pause.ID, "approve", approveAll(1)))
	assertCode(t, err, "unsupported")
	if len(caller.models) != 0 || len(caller.calls) != 0 {
		t.Fatal("dispatched after a refused record")
	}
}

func TestAFailedPersistedRunReturnsNoRecordAndALaterAttemptStartsFromTheStoredOne(t *testing.T) {
	definition := definitionOf(gateEntry)
	seed := &scripted{replies: []string{calls("math_double_1", `{"value":3}`)}, capability: echoCapability}
	paused := persisted(t, galaxie.NewStore(), seed, definition, galaxie.Input{Prompt: "go"})
	failing := &scripted{capability: func(llm.CapabilityRequest) (string, error) { return "", llm.NewError("budget_exceeded") }}
	store := galaxie.NewStore()
	result, err := store.Run(context.Background(), failing, definition, resumeFrom(paused.Record, paused.Pause.ID, "approve", approveAll(1)))
	assertCode(t, err, "budget_exceeded")
	if result.Record != nil {
		t.Fatalf("a failed run produced a record: %s", result.Record)
	}
	// The same store retries from the stored record; the call keeps the scope it had.
	retry := &scripted{replies: []string{reply("It is 6.")}, capability: echoCapability}
	done, err := store.Run(context.Background(), retry, definition, func() galaxie.Input {
		input := resumeFrom(paused.Record, paused.Pause.ID, "approve", approveAll(1))
		input.Persist = true
		return input
	}())
	if err != nil || done.Output != "It is 6." || retry.calls[0].EffectScope != "adk-go/c/root/1/0" {
		t.Fatalf("result = %+v, err = %v, calls = %+v", done, err, retry.calls)
	}
}
