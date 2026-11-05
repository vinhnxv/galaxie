// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie

import (
	"encoding/json"
	"testing"

	"google.golang.org/adk/model"
	"google.golang.org/adk/session"
	"google.golang.org/genai"
)

func TestEmptyCallArgumentsAndResponsesSurviveAStoredRoundTrip(t *testing.T) {
	event := session.NewEvent("invocation")
	event.Author = "root"
	event.LLMResponse = model.LLMResponse{Content: &genai.Content{Role: "user", Parts: []*genai.Part{
		{FunctionCall: &genai.FunctionCall{Name: "transfer", Args: map[string]any{}}},
		{FunctionResponse: &genai.FunctionResponse{Name: "transfer", Response: map[string]any{}}},
	}}}
	stored, err := storedEventOf(event)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(stored)
	if err != nil {
		t.Fatal(err)
	}
	var decoded storedEvent
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	parts := sessionEventOf(decoded).Content.Parts
	if parts[0].FunctionCall.Args == nil || len(parts[0].FunctionCall.Args) != 0 {
		t.Fatalf("args = %#v", parts[0].FunctionCall.Args)
	}
	if parts[1].FunctionResponse.Response == nil || len(parts[1].FunctionResponse.Response) != 0 {
		t.Fatalf("response = %#v", parts[1].FunctionResponse.Response)
	}
}

func TestAStoredPartWithoutArgumentsOrResponseKeysStillDecodes(t *testing.T) {
	var part storedPart
	raw := `{"functionCall":{"name":"a"},"functionResponse":{"name":"a"}}`
	if err := json.Unmarshal([]byte(raw), &part); err != nil {
		t.Fatal(err)
	}
	if part.FunctionCall.Args != nil || part.FunctionResponse.Response != nil {
		t.Fatalf("part = %#v", part)
	}
}
