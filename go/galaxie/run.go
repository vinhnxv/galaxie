// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

package galaxie

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/platform"
	"google.golang.org/adk/runner"
	"google.golang.org/adk/session"
	"google.golang.org/genai"

	"galaxie.invalid/galaxie/galaxie/llm"
)

// Entry builds the root agent of one agent module. It runs inside a recorder, so it must create
// every agent, tool and model with this package's constructors.
type Entry func() (agent.Agent, error)

// Input is what one run receives from the page.
type Input struct {
	Prompt string
	// Conversation names the run's conversation inside capability effect scopes.
	Conversation string
}

const (
	appName = "galaxie"
	userID  = "user"
)

// Execute builds the entry's agent, checks its tree and runs one prompt to completion. The reply is
// the text of the final response. A failure is an *llm.Error with a galaxie code; the first fatal
// failure the model or a tool recorded wins over whatever ADK reported afterwards.
func Execute(parent context.Context, caller llm.Caller, entry Entry, input Input) (string, error) {
	root, err := record(entry)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	run := llm.NewRun(caller, input.Conversation, cancel)
	ctx = run.With(ctx)
	counter := atomic.Int64{}
	ctx = platform.WithUUIDProvider(ctx, func() string { return fmt.Sprintf("%d", counter.Add(1)) })
	ctx = platform.WithTimeProvider(ctx, func() time.Time {
		return time.UnixMilli(counter.Add(1))
	})

	service := session.InMemoryService()
	sessionID := "session"
	if _, err := service.Create(ctx, &session.CreateRequest{AppName: appName, UserID: userID, SessionID: sessionID}); err != nil {
		return "", llm.NewError("unavailable")
	}
	adk, err := runner.New(runner.Config{AppName: appName, Agent: root, SessionService: service})
	if err != nil {
		return "", llm.NewError("unsupported")
	}
	message := &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{Text: input.Prompt}}}
	var output string
	var failure error
	for event, err := range adk.Run(ctx, userID, sessionID, message, agent.RunConfig{StreamingMode: agent.StreamingModeNone}) {
		if err != nil {
			failure = err
			break
		}
		if event == nil {
			continue
		}
		if event.ErrorCode != "" && failure == nil {
			failure = llm.NewError("unavailable")
		}
		if event.IsFinalResponse() && event.Content != nil {
			if text := textOf(event.Content); text != "" || output == "" {
				output = text
			}
		}
	}
	if fatal := run.Fatal(); fatal != nil {
		return "", fatal
	}
	if run.Cancelled() || ctx.Err() != nil && parent.Err() != nil {
		return "", llm.NewError("cancelled")
	}
	if failure != nil {
		return "", llm.NewError(llm.CodeOf(failure))
	}
	return output, nil
}

func textOf(content *genai.Content) string {
	var text strings.Builder
	for _, part := range content.Parts {
		if part != nil && !part.Thought && part.FunctionCall == nil && part.FunctionResponse == nil {
			text.WriteString(part.Text)
		}
	}
	return text.String()
}
