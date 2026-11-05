// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package llm

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"

	"google.golang.org/adk/model"
	"google.golang.org/genai"
)

// RequestToWire maps an ADK request to the chat messages the page routes. Parts the router cannot
// carry (files, inline data, code execution) fail "unsupported" instead of being dropped.
func RequestToWire(role string, request *model.LLMRequest) (ModelRequest, error) {
	wire := ModelRequest{Role: role, Messages: []Message{}}
	config := request.Config
	if config != nil {
		if config.SystemInstruction != nil {
			text, err := textOf(config.SystemInstruction.Parts)
			if err != nil {
				return wire, err
			}
			if text != "" {
				wire.Messages = append(wire.Messages, Message{Role: "system", Content: text})
			}
		}
		if len(config.StopSequences) > 0 {
			wire.Options.Stop = append([]string(nil), config.StopSequences...)
		}
		tools, err := toolDefinitions(config.Tools)
		if err != nil {
			return wire, err
		}
		wire.Options.Tools = tools
		schema, err := responseSchema(config)
		if err != nil {
			return wire, err
		}
		wire.Options.JSONSchema = schema
		if config.ToolConfig != nil {
			return wire, NewError("unsupported")
		}
	}
	ids := &callIDs{}
	for _, content := range request.Contents {
		if content == nil {
			continue
		}
		messages, err := contentMessages(content, ids)
		if err != nil {
			return wire, err
		}
		wire.Messages = append(wire.Messages, messages...)
	}
	return wire, nil
}

func textOf(parts []*genai.Part) (string, error) {
	var text strings.Builder
	for _, part := range parts {
		if part == nil {
			continue
		}
		if !textPart(part) {
			return "", NewError("unsupported")
		}
		text.WriteString(part.Text)
	}
	return text.String(), nil
}

func textPart(part *genai.Part) bool {
	return !part.Thought && part.ThoughtSignature == nil && part.FunctionCall == nil &&
		part.FunctionResponse == nil && part.InlineData == nil && part.FileData == nil &&
		part.ExecutableCode == nil && part.CodeExecutionResult == nil &&
		part.VideoMetadata == nil && part.MediaResolution == nil
}

// callIDs pairs function calls with their responses. ADK strips the IDs it generated before it
// builds a request, so a call without an ID gets one here and its response takes the oldest
// unanswered call of the same name.
type callIDs struct {
	next    int
	pending []pendingCall
}

type pendingCall struct{ id, name string }

func (c *callIDs) call(call *genai.FunctionCall) string {
	id := call.ID
	if id == "" {
		c.next++
		id = fmt.Sprintf("call-%d", c.next)
	}
	c.pending = append(c.pending, pendingCall{id: id, name: call.Name})
	return id
}

func (c *callIDs) response(response *genai.FunctionResponse) (string, bool) {
	for index, call := range c.pending {
		if (response.ID != "" && call.id == response.ID) || (response.ID == "" && call.name == response.Name) {
			c.pending = slices.Delete(c.pending, index, index+1)
			return call.id, true
		}
	}
	return "", false
}

func contentMessages(content *genai.Content, ids *callIDs) ([]Message, error) {
	if content.Role == genai.RoleModel {
		message := Message{Role: "assistant"}
		var text strings.Builder
		for _, part := range content.Parts {
			switch {
			case part == nil:
			case part.FunctionCall != nil:
				call := part.FunctionCall
				if call.Name == "" {
					return nil, NewError("invalid")
				}
				arguments, err := json.Marshal(nonNil(call.Args))
				if err != nil {
					return nil, NewError("invalid")
				}
				message.ToolCalls = append(message.ToolCalls, ToolCall{
					ID:       ids.call(call),
					Type:     "function",
					Function: FunctionCall{Name: call.Name, Arguments: string(arguments)},
				})
			case textPart(part):
				text.WriteString(part.Text)
			default:
				return nil, NewError("unsupported")
			}
		}
		message.Content = text.String()
		return []Message{message}, nil
	}
	var messages []Message
	var text strings.Builder
	flush := func() {
		if text.Len() > 0 {
			messages = append(messages, Message{Role: "user", Content: text.String()})
			text.Reset()
		}
	}
	for _, part := range content.Parts {
		switch {
		case part == nil:
		case part.FunctionResponse != nil:
			response := part.FunctionResponse
			id, ok := ids.response(response)
			if !ok {
				return nil, NewError("invalid")
			}
			flush()
			encoded, err := json.Marshal(nonNil(response.Response))
			if err != nil {
				return nil, NewError("invalid")
			}
			messages = append(messages, Message{
				Role:       "tool",
				Content:    string(encoded),
				ToolCallID: id,
			})
		case textPart(part):
			text.WriteString(part.Text)
		default:
			return nil, NewError("unsupported")
		}
	}
	flush()
	return messages, nil
}

func nonNil(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	return value
}

func toolDefinitions(tools []*genai.Tool) ([]ToolDefinition, error) {
	var definitions []ToolDefinition
	for _, tool := range tools {
		if tool == nil {
			continue
		}
		if len(tool.FunctionDeclarations) == 0 || otherToolKinds(tool) {
			return nil, NewError("unsupported")
		}
		for _, declaration := range tool.FunctionDeclarations {
			parameters, err := parametersOf(declaration)
			if err != nil {
				return nil, err
			}
			definitions = append(definitions, ToolDefinition{
				Type: "function",
				Function: ToolFunctionSchema{
					Name:        declaration.Name,
					Description: declaration.Description,
					Parameters:  parameters,
				},
			})
		}
	}
	return definitions, nil
}

func otherToolKinds(tool *genai.Tool) bool {
	copied := *tool
	copied.FunctionDeclarations = nil
	return !reflect.DeepEqual(copied, genai.Tool{})
}

func parametersOf(declaration *genai.FunctionDeclaration) (map[string]any, error) {
	switch {
	case declaration.ParametersJsonSchema != nil:
		return jsonObject(declaration.ParametersJsonSchema)
	case declaration.Parameters != nil:
		return schemaObject(declaration.Parameters)
	default:
		return map[string]any{"type": "object", "properties": map[string]any{}}, nil
	}
}

func responseSchema(config *genai.GenerateContentConfig) (map[string]any, error) {
	switch {
	case config.ResponseJsonSchema != nil:
		return jsonObject(config.ResponseJsonSchema)
	case config.ResponseSchema != nil:
		return schemaObject(config.ResponseSchema)
	default:
		return nil, nil
	}
}

func jsonObject(value any) (map[string]any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, NewError("invalid")
	}
	var object map[string]any
	if err := json.Unmarshal(encoded, &object); err != nil || object == nil {
		return nil, NewError("invalid")
	}
	return object, nil
}

// schemaObject converts an ADK schema, whose type names are upper case, to JSON Schema.
func schemaObject(schema *genai.Schema) (map[string]any, error) {
	object, err := jsonObject(schema)
	if err != nil {
		return nil, err
	}
	lowerTypes(object)
	return object, nil
}

func lowerTypes(value any) {
	switch node := value.(type) {
	case map[string]any:
		for key, child := range node {
			if key == "type" {
				if name, ok := child.(string); ok {
					node[key] = strings.ToLower(name)
					continue
				}
			}
			lowerTypes(child)
		}
	case []any:
		for _, child := range node {
			lowerTypes(child)
		}
	}
}

// ReplyToResponse maps the page's reply to an ADK response. The offered tool names are checked
// again here so a reply can only call a tool the request offered.
func ReplyToResponse(reply ModelReply, offered map[string]bool) (*model.LLMResponse, error) {
	parts := []*genai.Part{}
	if reply.Content != "" {
		parts = append(parts, &genai.Part{Text: reply.Content})
	}
	for _, call := range reply.ToolCalls {
		if call.Type != "function" || call.Function.Name == "" || !offered[call.Function.Name] {
			return nil, NewError("invalid")
		}
		var arguments map[string]any
		if call.Function.Arguments == "" {
			arguments = map[string]any{}
		} else if err := json.Unmarshal([]byte(call.Function.Arguments), &arguments); err != nil {
			return nil, NewError("invalid")
		}
		parts = append(parts, &genai.Part{
			FunctionCall: &genai.FunctionCall{Name: call.Function.Name, Args: nonNil(arguments)},
		})
	}
	response := &model.LLMResponse{
		Content:      &genai.Content{Role: genai.RoleModel, Parts: parts},
		TurnComplete: true,
	}
	if reply.Usage != nil {
		response.UsageMetadata = &genai.GenerateContentResponseUsageMetadata{
			PromptTokenCount:     int32(reply.Usage.InputTokens),
			CandidatesTokenCount: int32(reply.Usage.OutputTokens),
			TotalTokenCount:      int32(reply.Usage.TotalTokens),
		}
	}
	return response, nil
}
