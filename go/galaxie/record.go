// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

package galaxie

import (
	"bytes"
	"context"
	"encoding/json"
	"maps"
	"slices"
	"sync"
	"time"

	"google.golang.org/adk/session"
	"google.golang.org/adk/tool/toolconfirmation"
	"google.golang.org/genai"

	"galaxie.invalid/galaxie/galaxie/llm"
)

// A stored conversation is a record the page keeps between runs: the event log of one ADK session
// plus the counters that keep identifiers and effect scopes unique, and the pause it waits on.
// ADK Go has no session codec, so the record is written here: events serialize through closed
// shapes (nothing ADK adds later can leak into a record) and restore by creating a session and
// appending the stored events in order.
const (
	// MaxRecordBytes bounds a record. A bridge message is capped at llm.MaxFrameBytes including
	// the rest of the request or result, so a record gets half of it.
	MaxRecordBytes = 512 << 10
	// recordMargin is reserved inside MaxRecordBytes for the events a run appends after the last
	// size check, the final response and the pause.
	recordMargin  = 32 << 10
	recordVersion = 1
)

type storedCall struct {
	ID   string         `json:"id,omitempty"`
	Name string         `json:"name"`
	Args map[string]any `json:"args,omitempty"`
}

type storedResponse struct {
	ID       string         `json:"id,omitempty"`
	Name     string         `json:"name"`
	Response map[string]any `json:"response,omitempty"`
}

type storedPart struct {
	Text             string          `json:"text,omitempty"`
	Thought          bool            `json:"thought,omitempty"`
	FunctionCall     *storedCall     `json:"functionCall,omitempty"`
	FunctionResponse *storedResponse `json:"functionResponse,omitempty"`
}

type storedContent struct {
	Role  string       `json:"role,omitempty"`
	Parts []storedPart `json:"parts"`
}

type storedConfirmation struct {
	Hint      string `json:"hint,omitempty"`
	Confirmed bool   `json:"confirmed"`
	Payload   any    `json:"payload,omitempty"`
}

type storedActions struct {
	StateDelta                 map[string]any                `json:"stateDelta,omitempty"`
	RequestedToolConfirmations map[string]storedConfirmation `json:"requestedToolConfirmations,omitempty"`
	SkipSummarization          bool                          `json:"skipSummarization,omitempty"`
	TransferToAgent            string                        `json:"transferToAgent,omitempty"`
	Escalate                   bool                          `json:"escalate,omitempty"`
}

type storedEvent struct {
	ID                 string         `json:"id"`
	Timestamp          int64          `json:"timestamp"`
	InvocationID       string         `json:"invocationId,omitempty"`
	Branch             string         `json:"branch,omitempty"`
	Author             string         `json:"author,omitempty"`
	Content            *storedContent `json:"content,omitempty"`
	LongRunningToolIDs []string       `json:"longRunningToolIds,omitempty"`
	Actions            storedActions  `json:"actions"`
}

type storedPausedCall struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Request Request `json:"request"`
}

type storedPause struct {
	ID      string             `json:"id"`
	Request map[string]any     `json:"request"`
	Calls   []storedPausedCall `json:"calls"`
}

// conversationRecord is the stored form of one conversation. Pause is absent once the conversation completed.
type conversationRecord struct {
	Version      int    `json:"v"`
	Conversation string `json:"conversation"`
	// Ordinal is the next pause ordinal; the stored pause, if any, used the one before it.
	Ordinal int             `json:"ordinal"`
	Counter int64           `json:"counter"`
	Memory  llm.MemoryState `json:"memory"`
	Events  []storedEvent   `json:"events"`
	Pause   *storedPause    `json:"pause,omitempty"`
}

var allowedPartKeys = []string{"text", "thought", "functionCall", "functionResponse"}

// onlyKeys reports whether the JSON object holds nothing but the allowed keys.
func onlyKeys(raw []byte, allowed ...string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return false
	}
	for key := range fields {
		if !slices.Contains(allowed, key) {
			return false
		}
	}
	return true
}

// storedPartOf copies a part into the closed stored shape. A part with anything else, such as
// binary data, a file or code execution, is refused: those are never stored.
func storedPartOf(part *genai.Part) (storedPart, error) {
	if part == nil {
		return storedPart{}, llm.NewError("unsupported")
	}
	raw, err := json.Marshal(part)
	if err != nil || !onlyKeys(raw, allowedPartKeys...) {
		return storedPart{}, llm.NewError("unsupported")
	}
	stored := storedPart{Text: part.Text, Thought: part.Thought}
	if call := part.FunctionCall; call != nil {
		raw, err := json.Marshal(call)
		if err != nil || !onlyKeys(raw, "id", "name", "args") {
			return storedPart{}, llm.NewError("unsupported")
		}
		stored.FunctionCall = &storedCall{ID: call.ID, Name: call.Name, Args: call.Args}
	}
	if response := part.FunctionResponse; response != nil {
		raw, err := json.Marshal(response)
		if err != nil || !onlyKeys(raw, "id", "name", "response") {
			return storedPart{}, llm.NewError("unsupported")
		}
		stored.FunctionResponse = &storedResponse{ID: response.ID, Name: response.Name, Response: response.Response}
	}
	return stored, nil
}

func storedEventOf(event *session.Event) (storedEvent, error) {
	if len(event.Actions.ArtifactDelta) > 0 {
		return storedEvent{}, llm.NewError("unsupported")
	}
	stored := storedEvent{
		ID:                 event.ID,
		Timestamp:          event.Timestamp.UnixMilli(),
		InvocationID:       event.InvocationID,
		Branch:             event.Branch,
		Author:             event.Author,
		LongRunningToolIDs: slices.Clone(event.LongRunningToolIDs),
		Actions: storedActions{
			StateDelta:        maps.Clone(event.Actions.StateDelta),
			SkipSummarization: event.Actions.SkipSummarization,
			TransferToAgent:   event.Actions.TransferToAgent,
			Escalate:          event.Actions.Escalate,
		},
	}
	if confirmations := event.Actions.RequestedToolConfirmations; len(confirmations) > 0 {
		stored.Actions.RequestedToolConfirmations = map[string]storedConfirmation{}
		for id, confirmation := range confirmations {
			stored.Actions.RequestedToolConfirmations[id] = storedConfirmation{
				Hint:      confirmation.Hint,
				Confirmed: confirmation.Confirmed,
				Payload:   confirmation.Payload,
			}
		}
	}
	if event.Content != nil {
		content := &storedContent{Role: event.Content.Role, Parts: make([]storedPart, 0, len(event.Content.Parts))}
		for _, part := range event.Content.Parts {
			stored, err := storedPartOf(part)
			if err != nil {
				return storedEvent{}, err
			}
			content.Parts = append(content.Parts, stored)
		}
		stored.Content = content
	}
	return stored, nil
}

// sessionEventOf rebuilds the ADK event a stored one came from.
func sessionEventOf(stored storedEvent) *session.Event {
	event := &session.Event{
		ID:                 stored.ID,
		Timestamp:          time.UnixMilli(stored.Timestamp),
		InvocationID:       stored.InvocationID,
		Branch:             stored.Branch,
		Author:             stored.Author,
		LongRunningToolIDs: slices.Clone(stored.LongRunningToolIDs),
		Actions: session.EventActions{
			StateDelta:        stored.Actions.StateDelta,
			SkipSummarization: stored.Actions.SkipSummarization,
			TransferToAgent:   stored.Actions.TransferToAgent,
			Escalate:          stored.Actions.Escalate,
		},
	}
	if len(stored.Actions.RequestedToolConfirmations) > 0 {
		event.Actions.RequestedToolConfirmations = map[string]toolconfirmation.ToolConfirmation{}
		for id, confirmation := range stored.Actions.RequestedToolConfirmations {
			event.Actions.RequestedToolConfirmations[id] = toolconfirmation.ToolConfirmation{
				Hint:      confirmation.Hint,
				Confirmed: confirmation.Confirmed,
				Payload:   confirmation.Payload,
			}
		}
	}
	if stored.Content != nil {
		content := &genai.Content{Role: stored.Content.Role}
		for _, part := range stored.Content.Parts {
			restored := &genai.Part{Text: part.Text, Thought: part.Thought}
			if call := part.FunctionCall; call != nil {
				restored.FunctionCall = &genai.FunctionCall{ID: call.ID, Name: call.Name, Args: call.Args}
			}
			if response := part.FunctionResponse; response != nil {
				restored.FunctionResponse = &genai.FunctionResponse{ID: response.ID, Name: response.Name, Response: response.Response}
			}
			content.Parts = append(content.Parts, restored)
		}
		event.Content = content
	}
	return event
}

// eventSize is what one event adds to a record.
func eventSize(stored storedEvent) int {
	encoded, err := json.Marshal(stored)
	if err != nil {
		return MaxRecordBytes
	}
	return len(encoded) + 1
}

// sizedService counts the events a run appends and fails the run before the record could outgrow
// its frame: the next model or tool call is never dispatched once the projection is over the limit.
type sizedService struct {
	session.Service
	run *llm.Run

	mu   sync.Mutex
	size int
}

func (s *sizedService) AppendEvent(ctx context.Context, current session.Session, event *session.Event) error {
	if err := s.Service.AppendEvent(ctx, current, event); err != nil {
		return err
	}
	if event.Partial {
		return nil
	}
	stored, err := storedEventOf(event)
	if err != nil {
		return s.run.Fail(err)
	}
	s.mu.Lock()
	s.size += eventSize(stored)
	over := s.size > MaxRecordBytes-recordMargin
	s.mu.Unlock()
	if over {
		return s.run.Fail(llm.NewError("unsupported"))
	}
	return nil
}

// decodeRecord reads a record the page hands back. The shape is closed: an unknown field fails.
func decodeRecord(encoded []byte) (*conversationRecord, error) {
	if len(encoded) == 0 || len(encoded) > MaxRecordBytes {
		return nil, llm.NewError("invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var stored conversationRecord
	if decoder.Decode(&stored) != nil || decoder.More() {
		return nil, llm.NewError("invalid")
	}
	if stored.Version != recordVersion || stored.Conversation == "" || stored.Ordinal < 0 || stored.Counter < 0 ||
		stored.Memory.Turns == nil || stored.Memory.Scopes == nil {
		return nil, llm.NewError("invalid")
	}
	for _, event := range stored.Events {
		if event.ID == "" || event.Timestamp < 0 {
			return nil, llm.NewError("invalid")
		}
	}
	return &stored, nil
}

// eventsSize is the size the stored events add to a record.
func (r *conversationRecord) eventsSize() int {
	total := 0
	for _, event := range r.Events {
		total += eventSize(event)
	}
	return total
}

// pausedCalls turns the stored pause back into the calls an answer addresses and checks it
// against the stored events: every call must be the one the events hold, with the same request,
// and the interaction ID must cover the conversation, the ordinal and the stored request.
func (r *conversationRecord) pausedCalls() ([]pausedCall, error) {
	pause := r.Pause
	if pause == nil || len(pause.Calls) == 0 || r.Ordinal < 1 || pause.Request == nil {
		return nil, llm.NewError("invalid")
	}
	held := map[string]*genai.FunctionCall{}
	for _, event := range r.Events {
		if event.Content == nil {
			continue
		}
		for _, part := range event.Content.Parts {
			if call := part.FunctionCall; call != nil && call.ID != "" {
				held[call.ID] = &genai.FunctionCall{ID: call.ID, Name: call.Name, Args: call.Args}
			}
		}
	}
	calls := make([]pausedCall, 0, len(pause.Calls))
	requests := make([]Request, 0, len(pause.Calls))
	for _, stored := range pause.Calls {
		call := held[stored.ID]
		if call == nil || call.Name != stored.Name {
			return nil, llm.NewError("invalid")
		}
		var expected Request
		switch stored.Request.Kind {
		case KindConfirmation:
			derived, err := confirmationOf(call)
			if err != nil {
				return nil, err
			}
			expected = derived.request
		case KindLongRunning:
			expected = Request{Kind: KindLongRunning, Tool: call.Name, Args: copyMap(call.Args)}
		default:
			return nil, llm.NewError("invalid")
		}
		if !sameJSON(expected, stored.Request) {
			return nil, llm.NewError("invalid")
		}
		calls = append(calls, pausedCall{id: stored.ID, name: stored.Name, request: copyRequest(stored.Request)})
		requests = append(requests, copyRequest(stored.Request))
	}
	if pause.ID != interactionID(r.Conversation, r.Ordinal-1, requests, copyMap(pause.Request)) {
		return nil, llm.NewError("invalid")
	}
	return calls, nil
}

func sameJSON(left, right any) bool {
	first, err := json.Marshal(left)
	if err != nil {
		return false
	}
	second, err := json.Marshal(right)
	return err == nil && bytes.Equal(first, second)
}

// replay creates the session a record describes on a fresh service.
func (r *conversationRecord) replay(ctx context.Context, service session.Service) error {
	created, err := service.Create(ctx, &session.CreateRequest{AppName: appName, UserID: userID, SessionID: sessionID})
	if err != nil {
		return llm.NewError("unavailable")
	}
	for _, stored := range r.Events {
		if err := service.AppendEvent(ctx, created.Session, sessionEventOf(stored)); err != nil {
			return llm.NewError("invalid")
		}
	}
	return nil
}

// recordOf writes the conversation a run ends with: the events ADK stored, the counters, and the
// pause when there is one.
func recordOf(
	ctx context.Context,
	service session.Service,
	name string,
	ordinal int,
	counter int64,
	memory *llm.Memory,
	pause *storedPause,
) ([]byte, error) {
	found, err := service.Get(ctx, &session.GetRequest{AppName: appName, UserID: userID, SessionID: sessionID})
	if err != nil {
		return nil, llm.NewError("unavailable")
	}
	held := map[string]bool{}
	events := make([]storedEvent, 0, found.Session.Events().Len())
	for event := range found.Session.Events().All() {
		stored, err := storedEventOf(event)
		if err != nil {
			return nil, err
		}
		if stored.Content != nil {
			for _, part := range stored.Content.Parts {
				if part.FunctionCall != nil {
					held[part.FunctionCall.ID] = true
				}
			}
		}
		events = append(events, stored)
	}
	encoded, err := json.Marshal(conversationRecord{
		Version:      recordVersion,
		Conversation: name,
		Ordinal:      ordinal,
		Counter:      counter,
		Memory:       memory.Snapshot(func(callID string) bool { return held[callID] }),
		Events:       events,
		Pause:        pause,
	})
	if err != nil || len(encoded) > MaxRecordBytes {
		return nil, llm.NewError("unsupported")
	}
	return encoded, nil
}

func pauseRecordOf(id string, request map[string]any, calls []pausedCall) *storedPause {
	stored := &storedPause{ID: id, Request: request, Calls: make([]storedPausedCall, len(calls))}
	for index, call := range calls {
		stored.Calls[index] = storedPausedCall{ID: call.id, Name: call.name, Request: copyRequest(call.request)}
	}
	return stored
}
