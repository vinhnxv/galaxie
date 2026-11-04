// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"google.golang.org/adk/model"
	"google.golang.org/adk/platform"
	"google.golang.org/genai"
)

type fakeCaller struct {
	requests [][]byte
	replies  []string
	err      error
}

func (f *fakeCaller) Call(_ context.Context, op string, payload []byte) ([]byte, error) {
	if op != "model" {
		return nil, NewError("invalid")
	}
	f.requests = append(f.requests, payload)
	if f.err != nil {
		return nil, f.err
	}
	reply := f.replies[0]
	f.replies = f.replies[1:]
	return []byte(reply), nil
}

func newRun(caller Caller) (*Run, context.Context) {
	ctx, cancel := context.WithCancel(context.Background())
	counter := atomic.Int64{}
	ctx = platform.WithUUIDProvider(ctx, func() string {
		return fmt.Sprintf("%d", counter.Add(1))
	})
	run := NewRun(caller, "conversation", cancel)
	return run, run.With(ctx)
}

func collect(t *testing.T, ctx context.Context, request *model.LLMRequest) (*model.LLMResponse, error) {
	t.Helper()
	var response *model.LLMResponse
	var failure error
	for r, err := range New("answer").GenerateContent(ctx, request, false) {
		response, failure = r, err
	}
	return response, failure
}

func userRequest(text string, config *genai.GenerateContentConfig) *model.LLMRequest {
	return &model.LLMRequest{
		Contents: []*genai.Content{{Role: genai.RoleUser, Parts: []*genai.Part{{Text: text}}}},
		Config:   config,
	}
}

func TestTextRoundTrip(t *testing.T) {
	caller := &fakeCaller{replies: []string{`{"content":"hello","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}`}}
	_, ctx := newRun(caller)
	run := FromContext(ctx)
	_ = run
	response, err := collect(t, ctx, userRequest("hi", &genai.GenerateContentConfig{
		SystemInstruction: genai.NewContentFromText("be brief", genai.RoleUser),
	}))
	if err != nil {
		t.Fatal(err)
	}
	if got := response.Content.Parts[0].Text; got != "hello" {
		t.Fatalf("text = %q", got)
	}
	if response.UsageMetadata == nil || response.UsageMetadata.TotalTokenCount != 5 {
		t.Fatalf("usage = %+v", response.UsageMetadata)
	}
	var sent ModelRequest
	if err := json.Unmarshal(caller.requests[0], &sent); err != nil {
		t.Fatal(err)
	}
	if sent.Role != "answer" || len(sent.Messages) != 2 ||
		sent.Messages[0].Role != "system" || sent.Messages[1].Content != "hi" {
		t.Fatalf("request = %+v", sent)
	}
}

func declarations() *genai.GenerateContentConfig {
	return &genai.GenerateContentConfig{Tools: []*genai.Tool{{FunctionDeclarations: []*genai.FunctionDeclaration{{
		Name:        "double",
		Description: "Double it.",
		Parameters: &genai.Schema{
			Type:       genai.TypeObject,
			Properties: map[string]*genai.Schema{"value": {Type: genai.TypeInteger}},
			Required:   []string{"value"},
		},
	}}}}}
}

func TestFunctionCallIdsAreDeterministicAndProviderIdsDropped(t *testing.T) {
	reply := `{"content":"","toolCalls":[{"id":"provider-1","type":"function","function":{"name":"double","arguments":"{\"value\":3}"}}]}`
	ids := func() string {
		caller := &fakeCaller{replies: []string{reply}}
		_, ctx := newRun(caller)
		response, err := collect(t, ctx, userRequest("go", declarations()))
		if err != nil {
			t.Fatal(err)
		}
		call := response.Content.Parts[0].FunctionCall
		if call.Name != "double" || call.Args["value"] != float64(3) {
			t.Fatalf("call = %+v", call)
		}
		var sent ModelRequest
		_ = json.Unmarshal(caller.requests[0], &sent)
		parameters := sent.Options.Tools[0].Function.Parameters
		if parameters["type"] != "object" {
			t.Fatalf("type = %v", parameters["type"])
		}
		return call.ID
	}
	first, second := ids(), ids()
	if first != second || !strings.HasPrefix(first, "adk-") || strings.Contains(first, "provider") {
		t.Fatalf("ids = %q, %q", first, second)
	}
}

func TestAnUnofferedToolNameFailsInvalidAndEndsTheRun(t *testing.T) {
	reply := `{"content":"","toolCalls":[{"id":"x","type":"function","function":{"name":"other","arguments":"{}"}}]}`
	caller := &fakeCaller{replies: []string{reply, `{"content":"never"}`}}
	run, ctx := newRun(caller)
	if _, err := collect(t, ctx, userRequest("go", declarations())); CodeOf(err) != "invalid" {
		t.Fatalf("err = %v", err)
	}
	if run.Fatal() == nil || run.Fatal().Code != "invalid" {
		t.Fatalf("fatal = %v", run.Fatal())
	}
	if _, err := collect(t, ctx, userRequest("again", nil)); CodeOf(err) != "invalid" {
		t.Fatalf("second err = %v", err)
	}
	if len(caller.requests) != 1 {
		t.Fatalf("a failed run dispatched %d requests", len(caller.requests))
	}
}

func TestNonTextPartsFailUnsupported(t *testing.T) {
	for name, part := range map[string]*genai.Part{
		"inline": {InlineData: &genai.Blob{Data: []byte("x"), MIMEType: "image/png"}},
		"file":   {FileData: &genai.FileData{FileURI: "gs://x", MIMEType: "image/png"}},
		"code":   {ExecutableCode: &genai.ExecutableCode{Code: "1"}},
	} {
		caller := &fakeCaller{replies: []string{`{"content":"x"}`}}
		_, ctx := newRun(caller)
		request := &model.LLMRequest{Contents: []*genai.Content{{Role: genai.RoleUser, Parts: []*genai.Part{part}}}}
		if _, err := collect(t, ctx, request); CodeOf(err) != "unsupported" {
			t.Fatalf("%s: err = %v", name, err)
		}
		if len(caller.requests) != 0 {
			t.Fatalf("%s: dispatched", name)
		}
	}
}

func TestAnOversizedRequestIsRefusedBeforeDispatch(t *testing.T) {
	caller := &fakeCaller{replies: []string{`{"content":"x"}`}}
	_, ctx := newRun(caller)
	big := strings.Repeat("a", MaxFrameBytes+1)
	if _, err := collect(t, ctx, userRequest(big, nil)); CodeOf(err) != "unsupported" {
		t.Fatalf("err = %v", err)
	}
	if len(caller.requests) != 0 {
		t.Fatal("an oversized request was dispatched")
	}
}

func TestStructuredOutputSchemaReachesTheOptions(t *testing.T) {
	caller := &fakeCaller{replies: []string{`{"content":"{\"a\":1}"}`}}
	_, ctx := newRun(caller)
	config := &genai.GenerateContentConfig{
		ResponseMIMEType: "application/json",
		ResponseSchema: &genai.Schema{
			Type:       genai.TypeObject,
			Properties: map[string]*genai.Schema{"a": {Type: genai.TypeInteger}},
		},
	}
	if _, err := collect(t, ctx, userRequest("go", config)); err != nil {
		t.Fatal(err)
	}
	var sent ModelRequest
	_ = json.Unmarshal(caller.requests[0], &sent)
	properties, _ := sent.Options.JSONSchema["properties"].(map[string]any)
	field, _ := properties["a"].(map[string]any)
	if sent.Options.JSONSchema["type"] != "object" || field["type"] != "integer" {
		t.Fatalf("schema = %v", sent.Options.JSONSchema)
	}
}

func TestToolResultsMapToToolMessages(t *testing.T) {
	caller := &fakeCaller{replies: []string{`{"content":"done"}`}}
	_, ctx := newRun(caller)
	request := &model.LLMRequest{Contents: []*genai.Content{
		{Role: genai.RoleUser, Parts: []*genai.Part{{Text: "go"}}},
		{Role: genai.RoleModel, Parts: []*genai.Part{{FunctionCall: &genai.FunctionCall{
			ID: "adk-1", Name: "double", Args: map[string]any{"value": 3},
		}}}},
		{Role: genai.RoleUser, Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{
			ID: "adk-1", Name: "double", Response: map[string]any{"value": 6},
		}}}},
	}, Config: declarations()}
	if _, err := collect(t, ctx, request); err != nil {
		t.Fatal(err)
	}
	var sent ModelRequest
	_ = json.Unmarshal(caller.requests[0], &sent)
	if len(sent.Messages) != 3 || sent.Messages[1].ToolCalls[0].ID != "adk-1" ||
		sent.Messages[2].Role != "tool" || sent.Messages[2].ToolCallID != "adk-1" {
		t.Fatalf("messages = %+v", sent.Messages)
	}
}

func TestACallerFailureIsFatalAndKeepsItsCode(t *testing.T) {
	caller := &fakeCaller{err: NewError("denied")}
	run, ctx := newRun(caller)
	if _, err := collect(t, ctx, userRequest("go", nil)); CodeOf(err) != "denied" {
		t.Fatalf("err = %v", err)
	}
	if run.Fatal().Code != "denied" {
		t.Fatalf("fatal = %v", run.Fatal())
	}
}

func TestErrorsCarryOnlyFixedText(t *testing.T) {
	if got := NewError("denied").Error(); got != "Policy denied the request." {
		t.Fatalf("message = %q", got)
	}
	if CodeOf(errors.New("secret detail")) != "unavailable" {
		t.Fatal("an arbitrary error must map to unavailable")
	}
	if NewError("made-up").Code != "unavailable" {
		t.Fatal("an unknown code must map to unavailable")
	}
}

func TestStreamingIsUnsupportedAndEndsTheRun(t *testing.T) {
	caller := &fakeCaller{}
	run, ctx := newRun(caller)
	var failure error
	for _, err := range New("answer").GenerateContent(ctx, userRequest("go", nil), true) {
		failure = err
	}
	if CodeOf(failure) != "unsupported" || run.Fatal() == nil {
		t.Fatalf("err = %v", failure)
	}
}
