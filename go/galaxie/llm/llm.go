// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

package llm

import (
	"context"
	"iter"

	"google.golang.org/adk/model"
	"google.golang.org/adk/platform"
)

// LLM is the model every galaxie agent uses. A call goes to the page, which routes it by role
// through galaxie's model router; the Go side holds no provider, endpoint or credential.
type LLM struct {
	role string
}

// New returns the model for a role the host routes.
func New(role string) *LLM { return &LLM{role: role} }

// Role is the routed role this model sends its calls to.
func (m *LLM) Role() string { return m.role }

// Name implements model.LLM. It is the role, not a provider model name.
func (m *LLM) Name() string { return m.role }

// GenerateContent implements model.LLM. It dispatches nothing once the run has failed, and any
// failure here ends the run: a model call has no way to report an error back to the model.
func (m *LLM) GenerateContent(
	ctx context.Context,
	request *model.LLMRequest,
	stream bool,
) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		run := FromContext(ctx)
		if run == nil {
			yield(nil, NewError("unavailable"))
			return
		}
		if fatal := run.Fatal(); fatal != nil {
			yield(nil, fatal)
			return
		}
		if stream {
			yield(nil, run.Fail(NewError("unsupported")))
			return
		}
		response, err := m.call(ctx, run, request)
		if err != nil {
			yield(nil, run.Fail(err))
			return
		}
		yield(response, nil)
	}
}

func (m *LLM) call(ctx context.Context, run *Run, request *model.LLMRequest) (*model.LLMResponse, error) {
	wire, err := RequestToWire(m.role, request)
	if err != nil {
		return nil, err
	}
	offered := map[string]bool{}
	for _, tool := range wire.Options.Tools {
		offered[tool.Function.Name] = true
	}
	payload, err := encodeFrame(wire)
	if err != nil {
		return nil, err
	}
	encoded, err := run.Caller().Call(ctx, "model", payload)
	if err != nil {
		return nil, err
	}
	var reply ModelReply
	if err := decodeFrame(encoded, &reply); err != nil {
		return nil, err
	}
	response, err := ReplyToResponse(reply, offered)
	if err != nil {
		return nil, err
	}
	// ADK assigns "adk-" plus a provider identifier to calls without one. Doing it here lets the
	// run remember each call's effect scope; the identifiers still come from the run's provider.
	branch := branchOf(ctx)
	part := 0
	for _, content := range response.Content.Parts {
		if content.FunctionCall == nil {
			continue
		}
		content.FunctionCall.ID = "adk-" + platform.NewUUID(ctx)
		run.remember(content.FunctionCall.ID, branch, part)
		part++
	}
	return response, nil
}

// branchOf reads the agent branch from the context ADK passes to the model, when it exposes one.
func branchOf(ctx context.Context) string {
	if source, ok := ctx.(interface{ Branch() string }); ok {
		return sanitizeBranch(source.Branch())
	}
	return ""
}
