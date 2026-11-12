// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie_test

// Native ADK Go v1.9.0 and shipped-executor measurements with scripted models:
// NA1 passes: both call orders and two ordinary siblings retain every result.
// GA1/GA2 pass: one confirmation-only pause; restored bytes deliver the same
// ordered native results, without running ordinary calls again.
// GA3 passes with fake host receipts: live/reload/failed-resume retries keep
// the uninterrupted script's scopes and one approval/invocation per write.
// GA4 passes for persisted pauses: invalid partial/wrong-kind answers dispatch
// nothing and the original pause bytes remain answerable in a fresh Store.
// GA5 retains the existing refusals; full conformance remains a separate gate.
// NB1 fails: combined answers keep the pending marker instead of the real
// long-running answer. GB1-GB5 have no native-parity candidate and are inapplicable.
// NB2: either split order delivers both outcomes after an intermediate model call.
// C-go is a source fact: the pinned module has no request_input tool or symbol.
// Ordinary siblings are eligible for support once new conformance goldens pass;
// long-running siblings and request input remain refused. No runtime code changes.

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/model"
	"google.golang.org/adk/runner"
	"google.golang.org/adk/session"
	"google.golang.org/adk/tool"
	"google.golang.org/adk/tool/functiontool"
	"google.golang.org/adk/tool/toolconfirmation"
	"google.golang.org/genai"

	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

const besideGate = "math_double_1"
const besideLong = "job_start_1"

var besideShapes = [][]string{
	{besideGate, "math_triple_1"},
	{"math_triple_1", besideGate},
	{"math_triple_1", besideGate, "math_other_1"},
}

type besideNative struct {
	names    []string
	requests [][]*genai.Content
	mu       sync.Mutex
	bodies   []string
}

func (*besideNative) Name() string { return "scripted" }

func (m *besideNative) GenerateContent(_ context.Context, request *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		encoded, _ := json.Marshal(request.Contents)
		var contents []*genai.Content
		_ = json.Unmarshal(encoded, &contents)
		m.requests = append(m.requests, contents)
		parts := []*genai.Part{{Text: "done"}}
		if len(m.requests) == 1 {
			parts = nil
			for index, name := range m.names {
				parts = append(parts, &genai.Part{FunctionCall: &genai.FunctionCall{
					ID: fmt.Sprintf("call-%d", index), Name: name, Args: map[string]any{"value": float64(index + 1)},
				}})
			}
		}
		yield(&model.LLMResponse{Content: &genai.Content{Role: genai.RoleModel, Parts: parts}}, nil)
	}
}

func besideNativeRun(t *testing.T, names []string, approved bool, split string) *besideNative {
	t.Helper()
	m := &besideNative{names: names}
	tools := make([]tool.Tool, 0, len(names))
	for _, name := range names {
		created, err := functiontool.New(functiontool.Config{
			Name: name, Description: "Run the operation.", RequireConfirmation: name == besideGate,
			IsLongRunning: name == besideLong,
		}, func(_ agent.ToolContext, args map[string]any) (map[string]any, error) {
			m.mu.Lock()
			m.bodies = append(m.bodies, name)
			m.mu.Unlock()
			if name == besideLong {
				return map[string]any{"pending": true}, nil
			}
			return map[string]any{"value": args["value"]}, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		tools = append(tools, created)
	}
	root, err := llmagent.New(llmagent.Config{Name: "agent", Model: m, Instruction: "Use the tools.", Tools: tools})
	if err != nil {
		t.Fatal(err)
	}
	service := session.InMemoryService()
	ctx := context.Background()
	if _, err := service.Create(ctx, &session.CreateRequest{AppName: "beside", UserID: "user", SessionID: "session"}); err != nil {
		t.Fatal(err)
	}
	r, err := runner.New(runner.Config{AppName: "beside", Agent: root, SessionService: service})
	if err != nil {
		t.Fatal(err)
	}
	var gate *genai.FunctionCall
	for event, err := range r.Run(ctx, "user", "session", genai.NewContentFromText("go", genai.RoleUser), agent.RunConfig{}) {
		if err != nil {
			t.Fatal(err)
		}
		if event.Content == nil {
			continue
		}
		for _, part := range event.Content.Parts {
			if part.FunctionCall != nil && part.FunctionCall.Name == toolconfirmation.FunctionCallName {
				gate = part.FunctionCall
			}
		}
		if gate != nil {
			break
		}
	}
	if gate == nil || slices.Contains(m.bodies, besideGate) || len(m.requests) != 1 {
		t.Fatalf("initial gate=%+v bodies=%v requests=%d", gate, m.bodies, len(m.requests))
	}
	gatePart := &genai.Part{FunctionResponse: &genai.FunctionResponse{ID: gate.ID, Name: gate.Name, Response: map[string]any{"confirmed": approved}}}
	var longPart *genai.Part
	for index, name := range names {
		if name == besideLong {
			longPart = &genai.Part{FunctionResponse: &genai.FunctionResponse{
				ID: fmt.Sprintf("call-%d", index), Name: name, Response: map[string]any{"answer": "long-answer"},
			}}
		}
	}
	answers := [][]*genai.Part{{gatePart}}
	if longPart != nil {
		switch split {
		case "gate":
			answers = [][]*genai.Part{{gatePart}, {longPart}}
		case "long":
			answers = [][]*genai.Part{{longPart}, {gatePart}}
		default:
			answers = [][]*genai.Part{{gatePart, longPart}}
		}
	}
	for _, parts := range answers {
		for _, err := range r.Run(ctx, "user", "session", &genai.Content{Role: genai.RoleUser, Parts: parts}, agent.RunConfig{}) {
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	return m
}

func besideNativeResults(contents []*genai.Content) []string {
	var found []string
	for _, content := range contents {
		for _, part := range content.Parts {
			if response := part.FunctionResponse; response != nil && response.Name != toolconfirmation.FunctionCallName {
				encoded, _ := json.Marshal(response.Response)
				found = append(found, response.Name+":"+string(encoded))
			}
		}
	}
	return found
}

func TestNativeConfirmationBesideOrdinaryCallsPreservesEveryResult(t *testing.T) {
	for _, names := range besideShapes {
		for _, approved := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/%t", strings.Join(names, "/"), approved), func(t *testing.T) {
				m := besideNativeRun(t, names, approved, "")
				if len(m.requests) != 2 {
					t.Fatalf("requests=%d", len(m.requests))
				}
				results := besideNativeResults(m.requests[1])
				if len(results) != len(names) {
					t.Fatalf("results=%v", results)
				}
				for index, name := range names {
					count := 0
					for _, body := range m.bodies {
						if body == name {
							count++
						}
					}
					wantCount := 1
					if name == besideGate && !approved {
						wantCount = 0
					}
					if count != wantCount {
						t.Fatalf("%s bodies=%v", name, m.bodies)
					}
					want := fmt.Sprintf("%s:{\"value\":%d}", name, index+1)
					if name == besideGate && !approved {
						if !strings.Contains(strings.Join(results, "\n"), "rejected") {
							t.Fatalf("missing rejection: %v", results)
						}
					} else if !slices.Contains(results, want) {
						t.Fatalf("missing %q in %v", want, results)
					}
				}
			})
		}
	}
}

func TestNativeConfirmationBesideLongRunningCombinedAndSplitAnswers(t *testing.T) {
	for _, names := range [][]string{{besideGate, besideLong}, {besideLong, besideGate}} {
		for _, approved := range []bool{true, false} {
			for _, split := range []string{"", "gate", "long"} {
				t.Run(fmt.Sprintf("%s/%t/%s", strings.Join(names, "/"), approved, split), func(t *testing.T) {
					m := besideNativeRun(t, names, approved, split)
					results := besideNativeResults(m.requests[len(m.requests)-1])
					longResult := besideLong + `:{"pending":true}`
					wantRequests := 2
					if split != "" {
						longResult = besideLong + `:{"answer":"long-answer"}`
						wantRequests = 3
						intermediate := besideNativeResults(m.requests[1])
						if split == "gate" && !slices.Contains(intermediate, besideLong+`:{"pending":true}`) {
							t.Fatalf("the first split run lost its pending result: %v", intermediate)
						}
						if split == "long" && (!slices.Contains(intermediate, longResult) || !strings.Contains(strings.Join(intermediate, "\n"), "requires confirmation")) {
							t.Fatalf("the first split run lost its answer or unconfirmed gate: %v", intermediate)
						}
					}
					if len(m.requests) != wantRequests || len(results) != 2 || !slices.Contains(results, longResult) {
						t.Fatalf("requests=%d results=%v", len(m.requests), results)
					}
					wantBodies := []string{besideLong}
					if approved {
						wantBodies = append(wantBodies, besideGate)
					} else if !strings.Contains(strings.Join(results, "\n"), "rejected") {
						t.Fatalf("missing rejection: %v", results)
					}
					if !reflect.DeepEqual(m.bodies, wantBodies) {
						t.Fatalf("bodies=%v, want=%v", m.bodies, wantBodies)
					}
				})
			}
		}
	}
}

func besideEntry(gated bool) galaxie.Entry {
	return func() (agent.Agent, error) {
		var tools []tool.Tool
		for _, name := range []string{"math.double@1", "math.triple@1", "math.other@1"} {
			created, err := pausingTool(name, gated && name == "math.double@1", false)
			if err != nil {
				return nil, err
			}
			tools = append(tools, created)
		}
		return galaxie.LlmAgent(llmagent.Config{Name: "agent", Model: galaxie.Model("answer"), Instruction: "Use the tools.", Tools: tools})
	}
}

func besideScript(names []string) string {
	var pairs []string
	for index, name := range names {
		pairs = append(pairs, name, fmt.Sprintf(`{"value":%d}`, index+1))
	}
	return calls(pairs...)
}

func besideWireResults(messages []llm.Message) []string {
	names := map[string]string{}
	var found []string
	for _, message := range messages {
		for _, call := range message.ToolCalls {
			names[call.ID] = call.Function.Name
		}
		if message.Role == "tool" {
			found = append(found, names[message.ToolCallID]+":"+message.Content)
		}
	}
	return found
}

func TestConfirmationBesideOrdinaryCallsMatchesNativeLiveAndRestored(t *testing.T) {
	for _, names := range besideShapes {
		for _, approved := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/%t", strings.Join(names, "/"), approved), func(t *testing.T) {
				native := besideNativeRun(t, names, approved, "")
				want := besideNativeResults(native.requests[1])
				var liveModels []llm.ModelRequest
				var livePause *galaxie.Pause
				for _, reload := range []bool{false, true} {
					caller := &scripted{replies: []string{besideScript(names), reply("done")}, capability: func(request llm.CapabilityRequest) (string, error) {
						encoded, _ := json.Marshal(request.Input)
						return string(encoded), nil
					}}
					store := galaxie.NewStore()
					definition := definitionOf(besideEntry(true))
					var paused galaxie.Result
					if reload {
						paused = persisted(t, store, caller, definition, galaxie.Input{Prompt: "go"})
					} else {
						paused = start(t, store, caller, definition)
					}
					if paused.Pause == nil || !reflect.DeepEqual(paused.Pause.Tools, []string{besideGate}) || len(caller.calls) != len(names)-1 {
						t.Fatalf("pause=%+v calls=%v", paused.Pause, caller.calls)
					}
					for _, call := range caller.calls {
						if call.Name == "math.double@1" {
							t.Fatal("the gated tool ran before its answer")
						}
					}
					action := "deny"
					if approved {
						action = "approve"
					}
					if reload {
						store = galaxie.NewStore()
						if !reflect.DeepEqual(paused.Pause, livePause) {
							t.Fatal("the saved interaction differs from the live one")
						}
					}
					var done galaxie.Result
					if reload {
						done = persisted(t, store, caller, definition, resumeFrom(slices.Clone(paused.Record), paused.Pause.ID, action, approveAll(1)))
					} else {
						var err error
						done, err = answer(store, caller, definition, paused.Pause.ID, action, approveAll(1))
						if err != nil {
							t.Fatal(err)
						}
						liveModels = caller.models
						livePause = paused.Pause
					}
					if done.Pause != nil || done.Output != "done" || len(caller.models) != 2 {
						t.Fatalf("done=%+v models=%d", done, len(caller.models))
					}
					got := besideWireResults(caller.models[1].Messages)
					if !reflect.DeepEqual(got, want) {
						t.Fatalf("results=%v, native=%v", got, want)
					}
					if reload && !reflect.DeepEqual(caller.models, liveModels) {
						t.Fatal("the restored model requests differ from live")
					}
				}
			})
		}
	}
}

// The receipt map models successful host write receipts and host approvals. It is
// not a core broker integration test; the Worker conformance lane supplies that boundary.
func TestConfirmationBesideOrdinaryWritesKeepsScopesAndReceiptsAcrossRetry(t *testing.T) {
	for _, names := range besideShapes {
		for _, approved := range []bool{true, false} {
			for _, reload := range []bool{false, true} {
				for _, retry := range []bool{false, true} {
					t.Run(fmt.Sprintf("%s/%t/reload=%t/retry=%t", strings.Join(names, "/"), approved, reload, retry), func(t *testing.T) {
						baseline := &scripted{replies: []string{besideScript(names), reply("done")}, capability: echoCapability}
						persisted(t, galaxie.NewStore(), baseline, definitionOf(besideEntry(false)), galaxie.Input{Prompt: "go"})
						want := map[string]llm.CapabilityRequest{}
						for _, call := range baseline.calls {
							if approved || call.Name != "math.double@1" {
								want[call.EffectScope] = call
							}
						}
						receipts := map[string]llm.CapabilityRequest{}
						approvals := 0
						caller := &scripted{replies: []string{besideScript(names)}, capability: func(call llm.CapabilityRequest) (string, error) {
							if old, exists := receipts[call.EffectScope]; exists {
								if !reflect.DeepEqual(old, call) {
									t.Errorf("scope changed its write: old=%+v new=%+v", old, call)
								}
							} else {
								approvals++
								receipts[call.EffectScope] = call
							}
							return echoCapability(call)
						}}
						store := galaxie.NewStore()
						definition := definitionOf(besideEntry(true))
						paused := persisted(t, store, caller, definition, galaxie.Input{Prompt: "go"})
						if paused.Pause == nil || len(receipts) != len(names)-1 {
							t.Fatalf("pause=%+v receipts=%v", paused.Pause, receipts)
						}
						original := slices.Clone(paused.Record)
						if reload {
							store = galaxie.NewStore()
						}
						action := "deny"
						if approved {
							action = "approve"
						}
						if retry {
							result, err := store.Run(context.Background(), caller, definition, resumeFrom(paused.Record, paused.Pause.ID, action, approveAll(1)))
							assertCode(t, err, "unavailable")
							if result.Record != nil || !slices.Equal(paused.Record, original) || !reflect.DeepEqual(receipts, want) {
								t.Fatalf("failed resume changed records or receipts: result=%+v receipts=%v want=%v", result, receipts, want)
							}
						}
						caller.replies = []string{reply("done")}
						done := persisted(t, store, caller, definition, resumeFrom(original, paused.Pause.ID, action, approveAll(1)))
						if done.Output != "done" || done.Pause != nil || !reflect.DeepEqual(receipts, want) || approvals != len(want) {
							t.Fatalf("done=%+v approvals=%d receipts=%v want=%v", done, approvals, receipts, want)
						}
						if retry && !reflect.DeepEqual(caller.models[len(caller.models)-2], caller.models[len(caller.models)-1]) {
							t.Fatal("the failed and retried model requests differ")
						}
					})
				}
			}
		}
	}
}

func TestConfirmationBesideOrdinaryInvalidAnswersKeepPersistedPauseAnswerable(t *testing.T) {
	for _, wrongKind := range []bool{false, true} {
		t.Run(fmt.Sprintf("wrong-kind=%t", wrongKind), func(t *testing.T) {
			names := []string{"math_triple_1", besideGate, besideGate}
			caller := &scripted{replies: []string{besideScript(names), reply("done")}, capability: echoCapability}
			definition := definitionOf(besideEntry(true))
			if wrongKind {
				definition.Resume = func(requests []galaxie.Request, action string, _ any) ([]galaxie.Decision, error) {
					decisions := make([]galaxie.Decision, len(requests))
					for index := range decisions {
						decisions[index] = galaxie.Confirm(true)
						if action == "wrong" {
							decisions[index] = galaxie.Respond(map[string]any{"value": 1})
						}
					}
					return decisions, nil
				}
			}
			store := galaxie.NewStore()
			paused := persisted(t, store, caller, definition, galaxie.Input{Prompt: "go"})
			if paused.Pause == nil || len(paused.Pause.Tools) != 2 || len(caller.calls) != 1 {
				t.Fatalf("pause=%+v calls=%v", paused.Pause, caller.calls)
			}
			before := slices.Clone(paused.Record)
			action := "approve"
			if wrongKind {
				action = "wrong"
			}
			result, err := store.Run(context.Background(), caller, definition, resumeFrom(paused.Record, paused.Pause.ID, action, approveAll(1)))
			assertCode(t, err, "invalid")
			if result.Record != nil || len(caller.calls) != 1 || len(caller.models) != 1 || !slices.Equal(paused.Record, before) {
				t.Fatal("an invalid answer dispatched work or changed the saved pause")
			}
			done := persisted(t, galaxie.NewStore(), caller, definition, resumeFrom(before, paused.Pause.ID, "approve", approveAll(2)))
			if done.Output != "done" || len(caller.calls) != 3 {
				t.Fatalf("the saved pause was not answerable: done=%+v calls=%v", done, caller.calls)
			}
		})
	}
}

func TestConfirmationBesideLongRunningRefusesBothOrdersWithoutPublishingOrRunningTheGate(t *testing.T) {
	for _, names := range [][]string{{besideGate, besideLong}, {besideLong, besideGate}} {
		t.Run(strings.Join(names, "/"), func(t *testing.T) {
			caller := &scripted{replies: []string{besideScript(names), reply("fresh")}, capability: echoCapability}
			published := 0
			definition := definitionOf(gateEntry)
			definition.Interaction = func(requests []galaxie.Request) (map[string]any, error) {
				published++
				return show(requests)
			}
			store := galaxie.NewStore()
			result, err := store.Run(context.Background(), caller, definition, galaxie.Input{Prompt: "go", Conversation: "c", Persist: true})
			assertCode(t, err, "unsupported")
			if result.Record != nil || published != 0 || len(caller.calls) != 1 || caller.calls[0].Name != "job.start@1" {
				t.Fatalf("result=%+v published=%d calls=%v", result, published, caller.calls)
			}
			fresh := start(t, store, caller, definition)
			if fresh.Output != "fresh" || len(caller.models) != 2 || len(besideWireResults(caller.models[1].Messages)) != 0 {
				t.Fatal("the refused conversation leaked into the next run")
			}
		})
	}
}
