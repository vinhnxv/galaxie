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
	// Persist asks for the conversation's record when the run ends in a pause or completes. The
	// store then keeps no paused session: the caller hands the record back as Restore.
	Persist bool
	// Restore is the record a previous persisted run returned. With Resume it rebuilds the paused
	// session; with a new prompt it only carries the counters on, so identifiers and effect scopes
	// of the new conversation never repeat the stored ones.
	Restore []byte
}

// Result is how a run ended: the final text, or the pause it waits on. Record is the persisted
// conversation, set only for a run that asked to Persist.
type Result struct {
	Output string
	Pause  *Pause
	Record []byte
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
	id      string
	calls   []pausedCall
}

// Store keeps the conversations of one page session. A pause ends its run, and the answer arrives
// as a new run that continues the stored session, so the store lives as long as the Worker. Only
// a paused conversation keeps its session: a run that completes or fails leaves nothing behind.
type Store struct {
	mu            sync.Mutex
	conversations map[string]*conversation
	ordinals      map[string]int
	memories      map[string]*llm.Memory
	// lossyPauses lifts the tree rules. Only the evidence tests set it, to record what ADK does
	// when a pause is not refused.
	lossyPauses bool
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

func (s *Store) forget(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.conversations, name)
}

// claim takes the conversation's pause when id names it, and leaves it in place otherwise.
func (s *Store) claim(name, id string) *conversation {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.conversations[name]
	if kept == nil || kept.id != id {
		return nil
	}
	delete(s.conversations, name)
	return kept
}

func (s *Store) nextOrdinal(name string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	ordinal := s.ordinals[name]
	s.ordinals[name] = ordinal + 1
	return ordinal
}

// adopt makes the store continue a stored conversation's counters.
func (s *Store) adopt(name string, stored *conversationRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ordinals[name] = stored.Ordinal
	memory := llm.NewMemory()
	memory.Restore(stored.Memory)
	s.memories[name] = memory
}

func (s *Store) ordinal(name string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ordinals[name]
}

func (s *Store) keep(name string, kept *conversation) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conversations[name] = kept
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
	// A long-running tool runs before its pause, so a tree that cannot resume it is refused
	// before anything runs.
	if !s.lossyPauses && !built.longRunningResumes(root) {
		return Result{}, llm.NewError("unsupported")
	}
	name := input.Conversation
	var (
		restored *conversationRecord
		kept     *conversation
		message  *genai.Content
	)
	counter := &atomic.Int64{}
	if input.Restore != nil {
		stored, err := decodeRecord(input.Restore)
		if err != nil || stored.Conversation != name {
			return Result{}, llm.NewError("invalid")
		}
		restored = stored
	}
	switch {
	case input.Resume != nil && restored != nil:
		// The record is the whole truth: whatever the store holds for this conversation is stale.
		s.forget(name)
		if restored.Pause == nil || restored.Pause.ID != input.Resume.InteractionID {
			return Result{}, llm.NewError("stale")
		}
		if restored.eventsSize() > MaxRecordBytes-recordMargin {
			return Result{}, llm.NewError("unsupported")
		}
		calls, err := restored.pausedCalls()
		if err != nil {
			return Result{}, err
		}
		kept = &conversation{counter: counter, id: restored.Pause.ID, calls: calls}
		counter.Store(restored.Counter)
		s.adopt(name, restored)
	case input.Resume != nil:
		kept = s.claim(name, input.Resume.InteractionID)
		if kept == nil {
			return Result{}, llm.NewError("stale")
		}
		counter = kept.counter
	default:
		s.forget(name)
		if restored != nil {
			s.adopt(name, restored)
		}
		message = &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{Text: input.Prompt}}}
	}
	if kept != nil {
		resume := definition.Resume
		if resume == nil {
			resume = defaultResume
		}
		decisions, err := resume(requestsOf(kept.calls), input.Resume.Action, input.Resume.Payload)
		if err != nil {
			return Result{}, llm.NewError("invalid")
		}
		message, err = answerOf(kept.calls, decisions)
		if err != nil {
			return Result{}, err
		}
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

	var service session.Service
	switch {
	case kept != nil && kept.service != nil:
		service = kept.service
	default:
		service = session.InMemoryService()
		if restored != nil && kept != nil {
			if err := restored.replay(ctx, service); err != nil {
				return Result{}, err
			}
		} else if _, err := service.Create(ctx, &session.CreateRequest{AppName: appName, UserID: userID, SessionID: sessionID}); err != nil {
			return Result{}, llm.NewError("unavailable")
		}
	}
	if input.Persist {
		sized := &sizedService{Service: service, run: run}
		if restored != nil && kept != nil {
			sized.size = restored.eventsSize()
		}
		service = sized
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
		result := Result{Output: output}
		if input.Persist {
			encoded, err := recordOf(ctx, service, name, s.ordinal(name), counter.Load(), s.memory(name), nil)
			if err != nil {
				return Result{}, err
			}
			result.Record = encoded
		}
		return result, nil
	}
	if !s.lossyPauses && !built.resumesInPlace(root, watch.pausedBy) {
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
	id := interactionID(name, s.nextOrdinal(name), requests, request)
	result := Result{Pause: &Pause{ID: id, Request: request, Tools: tools}}
	if input.Persist {
		encoded, err := recordOf(ctx, service, name, s.ordinal(name), counter.Load(), s.memory(name), pauseRecordOf(id, request, watch.calls))
		if err != nil {
			return Result{}, err
		}
		result.Record = encoded
		return result, nil
	}
	s.keep(name, &conversation{service: service, counter: counter, id: id, calls: watch.calls})
	return result, nil
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
