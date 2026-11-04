// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

package llm

import (
	"bytes"
	"context"
	"encoding/json"
)

// MaxFrameBytes is the largest message either side accepts, as on the Python bridge.
const MaxFrameBytes = 1 << 20

// Caller sends one request to the page and returns its reply. op is "model" or "capability"; a
// failure carries a galaxie code as an *Error.
type Caller interface {
	Call(ctx context.Context, op string, payload []byte) ([]byte, error)
}

type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function FunctionCall `json:"function"`
}

type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// Message is one chat message. The page accepts exactly these key sets per role.
type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"toolCalls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type ToolDefinition struct {
	Type     string             `json:"type"`
	Function ToolFunctionSchema `json:"function"`
}

type ToolFunctionSchema struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters"`
}

type Options struct {
	Stop       []string         `json:"stop,omitempty"`
	Stream     bool             `json:"stream,omitempty"`
	Tools      []ToolDefinition `json:"tools,omitempty"`
	JSONSchema map[string]any   `json:"jsonSchema,omitempty"`
}

type ModelRequest struct {
	Role     string    `json:"role"`
	Messages []Message `json:"messages"`
	Options  Options   `json:"options"`
}

type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
	TotalTokens  int `json:"total_tokens"`
}

type ModelReply struct {
	Content   string     `json:"content"`
	ToolCalls []ToolCall `json:"toolCalls,omitempty"`
	Usage     *Usage     `json:"usage,omitempty"`
}

type CapabilityRequest struct {
	Name        string         `json:"name"`
	Input       map[string]any `json:"input"`
	EffectScope string         `json:"effectScope,omitempty"`
}

func encodeFrame(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, NewError("invalid")
	}
	if len(encoded) > MaxFrameBytes {
		return nil, NewError("unsupported")
	}
	return encoded, nil
}

func decodeFrame(encoded []byte, into any) error {
	if len(encoded) > MaxFrameBytes {
		return NewError("unsupported")
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return NewError("invalid")
	}
	if decoder.More() {
		return NewError("invalid")
	}
	return nil
}

// EncodeCapability marshals a capability request for the bridge.
func EncodeCapability(request CapabilityRequest) ([]byte, error) { return encodeFrame(request) }

// DecodeCapability parses a capability reply: any JSON value.
func DecodeCapability(encoded []byte) (any, error) {
	if len(encoded) > MaxFrameBytes {
		return nil, NewError("unsupported")
	}
	var value any
	if err := json.Unmarshal(encoded, &value); err != nil {
		return nil, NewError("invalid")
	}
	return value, nil
}
