// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

package galaxie

import (
	"context"
	"fmt"
	"strings"
	"sync"
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
	// Stream asks the page for checked text deltas while each model reply is produced.
	Stream bool
	// Resume answers the pause the conversation's previous run ended with; Prompt is ignored.
	Resume *Resumption
}

// Result is how a run ended: the final text, or the pause it waits on.
type Result struct {
	Output string
	Pause  *Pause
}

const (
	appName   = "galaxie"
	userID    = "user"
	sessionID = "session"
)

// conversation is what a run leaves behind when it pauses: the session the answer continues, the
// counters that keep generated identifiers unique, and the pause itself.
type conversation struct {
	service session.Service
	counter *atomic.Int64
	pending *pending
}

// Store keeps the conversations of one page session. A pause ends its run, and the answer arrives
// as a new run that continues the stored session, so the store lives as long as the Worker. Only
// a paused conversation keeps its session: a run that completes or fails leaves nothing behind.
type Store struct {
	mu            sync.Mutex
	conversations map[string]*conversation
	ordinals      map[string]int
	memories      map[string]*llm.Memory
}

// NewStore creates an empty store.
func NewStore() *Store {
	return &Store{
		conversations: map[string]*conversation{},
		ordinals:      map[string]int{},
		memories:      map[string]*llm.Memory{},
	}
}

func (s *Store) memory(name string) *llm.Memory {
	s.mu.Lock()
	defer s.mu.Unlock()
	memory, ok := s.memories[name]
	if !ok {
		memory = llm.NewMemory()
		s.memories[name] = memory
	}
	return memory
}

func (s *Store) paused(name string) *conversation {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conversations[name]
}

func (s *Store) forget(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.conversations, name)
}

func (s *Store) keep(name string, kept *conversation) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conversations[name] = kept
	ordinal := s.ordinals[name]
	s.ordinals[name] = ordinal + 1
	return ordinal
}

// Execute runs one prompt of a plain entry to completion. A run that would pause fails
// "unsupported": only Store.Run keeps the session an answer needs.
func Execute(parent context.Context, caller llm.Caller, entry Entry, input Input) (string, error) {
	result, err := NewStore().Run(parent, caller, Definition{Build: entry}, input)
	if err != nil {
		return "", err
	}
	if result.Pause != nil {
		return "", llm.NewError("unsupported")
	}
	return result.Output, nil
}

// Run builds the definition's agent, checks its tree and runs one prompt, or the answer to the
// conversation's pause, until the agent finishes or needs the user. The reply is the text of the
// final response. A failure is an *llm.Error with a galaxie code; the first fatal failure the
// model or a tool recorded wins over whatever ADK reported afterwards.
func (s *Store) Run(parent context.Context, caller llm.Caller, definition Definition, input Input) (Result, error) {
	root, built, err := record(definition.Build)
	if err != nil {
		return Result{}, err
	}
	// A pause with nowhere to show it would run its tool and then fail, so refuse it first.
	if built.pausing && definition.Interaction == nil {
		return Result{}, llm.NewError("unsupported")
	}
	name := input.Conversation
	var (
		service session.Service
		counter *atomic.Int64
		message *genai.Content
	)
	if input.Resume != nil {
		kept := s.paused(name)
		if kept == nil || kept.pending == nil || kept.pending.id != input.Resume.InteractionID {
			return Result{}, llm.NewError("stale")
		}
		s.forget(name)
		resume := definition.Resume
		if resume == nil {
			resume = defaultResume
		}
		decisions, err := resume(requestsOf(kept.pending.calls), input.Resume.Action, input.Resume.Payload)
		if err != nil {
			return Result{}, llm.NewError("invalid")
		}
		message, err = answerOf(kept.pending.calls, decisions)
		if err != nil {
			return Result{}, err
		}
		service, counter = kept.service, kept.counter
	} else {
		s.forget(name)
		service = session.InMemoryService()
		counter = &atomic.Int64{}
		message = &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{Text: input.Prompt}}}
	}

	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	run := llm.NewRun(caller, name, cancel)
	run.UseMemory(s.memory(name))
	ctx = run.With(ctx)
	ctx = platform.WithUUIDProvider(ctx, func() string { return fmt.Sprintf("%d", counter.Add(1)) })
	ctx = platform.WithTimeProvider(ctx, func() time.Time {
		return time.UnixMilli(counter.Add(1))
	})

	if input.Resume == nil {
		if _, err := service.Create(ctx, &session.CreateRequest{AppName: appName, UserID: userID, SessionID: sessionID}); err != nil {
			return Result{}, llm.NewError("unavailable")
		}
	}
	adk, err := runner.New(runner.Config{AppName: appName, Agent: root, SessionService: service})
	if err != nil {
		return Result{}, llm.NewError("unsupported")
	}
	var output string
	var failure error
	mode := agent.StreamingModeNone
	if input.Stream {
		mode = agent.StreamingModeSSE
	}
	watch := &tracker{}
	for event, err := range adk.Run(ctx, userID, sessionID, message, agent.RunConfig{StreamingMode: mode}) {
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
		stop, err := watch.observe(event)
		if err != nil {
			failure = err
			break
		}
		if stop {
			break
		}
		if event.IsFinalResponse() && event.Content != nil {
			if text := textOf(event.Content); text != "" || output == "" {
				output = text
			}
		}
	}
	if watch.unanswered() && failure == nil {
		failure = llm.NewError("unsupported")
	}
	if fatal := run.Fatal(); fatal != nil {
		return Result{}, fatal
	}
	if ctx.Err() != nil && parent.Err() != nil {
		return Result{}, llm.NewError("cancelled")
	}
	if failure != nil {
		return Result{}, llm.NewError(llm.CodeOf(failure))
	}
	if watch.calls == nil {
		return Result{Output: output}, nil
	}
	if !built.resumesInPlace(root, watch.pausedBy) {
		return Result{}, llm.NewError("unsupported")
	}
	requests := requestsOf(watch.calls)
	request, err := definition.Interaction(requestsOf(watch.calls))
	if err != nil || request == nil {
		return Result{}, llm.NewError("unsupported")
	}
	request = copyMap(request)
	tools := make([]string, len(requests))
	for index, each := range requests {
		tools[index] = each.Tool
	}
	kept := &conversation{service: service, counter: counter}
	ordinal := s.keep(name, kept)
	id := interactionID(name, ordinal, requests, request)
	kept.pending = &pending{id: id, calls: watch.calls}
	return Result{Pause: &Pause{ID: id, Request: request, Tools: tools}}, nil
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
