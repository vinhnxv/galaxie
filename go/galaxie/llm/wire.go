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

// ToolCall is one model-requested function call.
type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function FunctionCall `json:"function"`
}

// FunctionCall names a function and carries its JSON-encoded arguments.
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

// ToolDefinition is a function the model may call.
type ToolDefinition struct {
	Type     string             `json:"type"`
	Function ToolFunctionSchema `json:"function"`
}

// ToolFunctionSchema describes the function and its JSON Schema parameters.
type ToolFunctionSchema struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters"`
}

// Options are the per-call model options.
type Options struct {
	Stop       []string         `json:"stop,omitempty"`
	Stream     bool             `json:"stream,omitempty"`
	Tools      []ToolDefinition `json:"tools,omitempty"`
	JSONSchema map[string]any   `json:"jsonSchema,omitempty"`
}

// ModelRequest is the payload of the "model" operation.
type ModelRequest struct {
	Role     string    `json:"role"`
	Messages []Message `json:"messages"`
	Options  Options   `json:"options"`
}

// Usage is the provider-reported token use of one call.
type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
	TotalTokens  int `json:"total_tokens"`
}

// ModelReply is the page's answer to a "model" operation.
type ModelReply struct {
	Content   string     `json:"content"`
	ToolCalls []ToolCall `json:"toolCalls,omitempty"`
	Usage     *Usage     `json:"usage,omitempty"`
}

// CapabilityRequest is the payload of the "capability" operation.
type CapabilityRequest struct {
	Name        string         `json:"name"`
	Input       map[string]any `json:"input"`
	EffectScope string         `json:"effectScope,omitempty"`
}

// encodeFrame marshals a payload and refuses one over the frame limit.
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

// decodeFrame parses a reply strictly: unknown fields, trailing data and oversized frames fail
// with a fixed error.
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
