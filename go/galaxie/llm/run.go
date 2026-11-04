// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

package llm

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

type runKey struct{}

// Run is the state of one galaxie run. The model and every capability tool reach it through the
// context, so a failure in either ends the run even when agent code swallows the error.
type Run struct {
	caller       Caller
	cancel       context.CancelFunc
	conversation string

	// toolMu serializes capability round trips: ADK runs the sibling tools of one model turn on
	// separate goroutines, and a fatal failure must stop the later ones before they dispatch.
	toolMu sync.Mutex

	mu     sync.Mutex
	fatal  *Error
	memory *Memory
}

// Memory holds the effect scopes of one conversation. A run that resumes a paused conversation
// shares it with the run that paused, so the call a user confirmed keeps the scope it was given
// when the model asked for it, and the turn counters continue instead of starting over.
type Memory struct {
	mu     sync.Mutex
	turns  map[string]int
	scopes map[string]string
}

// NewMemory creates an empty scope memory.
func NewMemory() *Memory {
	return &Memory{turns: map[string]int{}, scopes: map[string]string{}}
}

// NewRun creates the state of a run. cancel ends the run's context.
func NewRun(caller Caller, conversation string, cancel context.CancelFunc) *Run {
	return &Run{
		caller:       caller,
		cancel:       cancel,
		conversation: conversation,
		memory:       NewMemory(),
	}
}

// UseMemory makes the run record and read effect scopes in the conversation's shared memory.
func (r *Run) UseMemory(memory *Memory) { r.memory = memory }

func (r *Run) With(ctx context.Context) context.Context {
	return context.WithValue(ctx, runKey{}, r)
}

// FromContext returns the run a context carries, or nil.
func FromContext(ctx context.Context) *Run {
	run, _ := ctx.Value(runKey{}).(*Run)
	return run
}

// Caller is the bridge to the page.
func (r *Run) Caller() Caller { return r.caller }

func (r *Run) Fatal() *Error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.fatal
}

// Fail records the first fatal failure and cancels the run context. Later failures are ignored so
// the outcome is the first cause.
func (r *Run) Fail(err error) *Error {
	failure := NewError(CodeOf(err))
	r.mu.Lock()
	if r.fatal == nil {
		r.fatal = failure
	}
	first := r.fatal
	r.mu.Unlock()
	r.cancel()
	return first
}

// LockTools serializes capability tools of this run; the returned function unlocks.
func (r *Run) LockTools() func() {
	r.toolMu.Lock()
	return r.toolMu.Unlock
}

func (r *Run) remember(callID, branch string, part int) {
	if branch == "" {
		branch = "root"
	}
	m := r.memory
	m.mu.Lock()
	defer m.mu.Unlock()
	if part == 0 {
		m.turns[branch]++
	}
	m.scopes[callID] = fmt.Sprintf("adk-go/%s/%s/%d/%d", r.conversation, branch, m.turns[branch], part)
}

// EffectScope returns the stable namespace of one function call, or "" if the call is unknown.
func (r *Run) EffectScope(callID string) string {
	m := r.memory
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.scopes[callID]
}

func sanitizeBranch(branch string) string {
	return strings.Map(func(c rune) rune {
		if c == '/' || c == ' ' {
			return '.'
		}
		return c
	}, branch)
}
