// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

package galaxie

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/session"
	"google.golang.org/adk/tool/toolconfirmation"
	"google.golang.org/genai"

	"galaxie.invalid/galaxie/galaxie/llm"
)

// Kinds of request a paused run waits on.
const (
	// KindConfirmation is a tool created with RequireConfirmation; it has not run.
	KindConfirmation = "confirmation"
	// KindLongRunning is a LongRunning tool that returned its pending result; the real result
	// arrives with the resume.
	KindLongRunning = "long-running"
)

// Request is one call the run waits on, as the author's Interaction and Resume hooks see it.
// Requests are addressed by position: ADK's call identifiers never reach author code.
type Request struct {
	Kind string         `json:"kind"`
	Tool string         `json:"tool"`
	Args map[string]any `json:"args"`
	Hint string         `json:"hint,omitempty"`
}

// Decision answers the request at the same position: Confirm for a confirmation, Respond for a
// long-running tool.
type Decision struct {
	confirmed *bool
	response  map[string]any
}

// Confirm approves or declines a confirmation request.
func Confirm(approved bool) Decision { return Decision{confirmed: &approved} }

// Respond supplies the real result of a long-running tool.
func Respond(response map[string]any) Decision { return Decision{response: response} }

// InteractionFunc builds the four-field interaction request (surfaceId, viewRevision, component,
// props) the host shows for the paused calls. The page checks it before anything is shown.
type InteractionFunc func(requests []Request) (map[string]any, error)

// ResumeFunc turns the user's action and payload into one decision per request, in order. It
// returns an error to refuse an answer it cannot map.
type ResumeFunc func(requests []Request, action string, payload any) ([]Decision, error)

// Definition is an agent module's entry and its pause handling. Without Interaction a module whose
// tools can pause is refused before it runs; without Resume the default approves or declines
// confirmations only.
type Definition struct {
	Build       Entry
	Interaction InteractionFunc
	Resume      ResumeFunc
}

// Resumption is the user's answer to the pause a previous run ended with.
type Resumption struct {
	InteractionID string
	Action        string
	Payload       any
}

// Pause is a run that stopped to wait for the user.
type Pause struct {
	// ID covers the conversation, the pause ordinal and the requests it shows.
	ID      string
	Request map[string]any
	// Tools names the paused tools, in request order, for content-free stream markers.
	Tools []string
}

// pausedCall is one ADK call a run waits on: the function-response identity its answer must carry.
type pausedCall struct {
	id      string
	name    string
	request Request
}

// pending is the pause a conversation waits on.
type pending struct {
	id    string
	calls []pausedCall
}

func requestsOf(calls []pausedCall) []Request {
	requests := make([]Request, len(calls))
	for index, call := range calls {
		requests[index] = copyRequest(call.request)
	}
	return requests
}

func copyRequest(request Request) Request {
	request.Args = copyMap(request.Args)
	return request
}

// copyMap deep-copies a JSON-shaped map; a value JSON cannot carry yields an empty map.
func copyMap(value map[string]any) map[string]any {
	encoded, err := json.Marshal(value)
	if err != nil {
		return map[string]any{}
	}
	var copied map[string]any
	if json.Unmarshal(encoded, &copied) != nil || copied == nil {
		return map[string]any{}
	}
	return copied
}

func interactionID(conversation string, ordinal int, requests []Request, request map[string]any) string {
	encoded, _ := json.Marshal([]any{conversation, ordinal, requests, request})
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

// tracker watches the events of one run for the point where ADK needs the user. A confirmation
// request ends the invocation by itself. A long-running tool pauses it only after the tool has
// returned its pending result, before ADK asks the model about it, so the driver stops there.
type tracker struct {
	// flagged holds the long-running calls of the latest tool turn that have no answer yet.
	flagged []*genai.FunctionCall
	turn    []*genai.FunctionCall
	author  string
	calls   []pausedCall
	// pausedBy names the agent whose turn paused.
	pausedBy string
}

func callsOf(event *session.Event) []*genai.FunctionCall {
	if event.Content == nil {
		return nil
	}
	var calls []*genai.FunctionCall
	for _, part := range event.Content.Parts {
		if part != nil && part.FunctionCall != nil {
			calls = append(calls, part.FunctionCall)
		}
	}
	return calls
}

func confirmationOf(call *genai.FunctionCall) (pausedCall, error) {
	original, err := toolconfirmation.OriginalCallFrom(call)
	if err != nil || original == nil || original.Name == "" || call.ID == "" {
		return pausedCall{}, llm.NewError("invalid")
	}
	hint := ""
	if encoded, err := json.Marshal(call.Args["toolConfirmation"]); err == nil {
		var confirmation struct {
			Hint string `json:"hint"`
		}
		if json.Unmarshal(encoded, &confirmation) == nil {
			hint = confirmation.Hint
		}
	}
	return pausedCall{
		id:   call.ID,
		name: toolconfirmation.FunctionCallName,
		request: Request{
			Kind: KindConfirmation,
			Tool: original.Name,
			Args: copyMap(original.Args),
			Hint: hint,
		},
	}, nil
}

// observe reports whether this event is the one the run pauses on. It fails "unsupported" for a
// turn ADK cannot resume faithfully.
func (t *tracker) observe(event *session.Event) (bool, error) {
	if event.Partial {
		return false, nil
	}
	calls := callsOf(event)
	var gates []*genai.FunctionCall
	for _, call := range calls {
		if call.Name == toolconfirmation.FunctionCallName {
			gates = append(gates, call)
		}
	}
	if len(gates) > 0 {
		paused := make([]pausedCall, 0, len(gates))
		for _, gate := range gates {
			entry, err := confirmationOf(gate)
			if err != nil {
				return false, err
			}
			paused = append(paused, entry)
		}
		t.calls = paused
		t.pausedBy = event.Author
		return true, nil
	}
	if len(calls) > 0 {
		t.turn = calls
		t.flagged = t.flagged[:0]
		t.author = event.Author
		for _, call := range calls {
			if call.ID != "" && slices.Contains(event.LongRunningToolIDs, call.ID) {
				t.flagged = append(t.flagged, call)
			}
		}
		return false, nil
	}
	// The next event after a turn with long-running calls carries their (possibly pending)
	// results; ADK would call the model about them next, so the run pauses here instead.
	if len(t.flagged) == 0 {
		return false, nil
	}
	// A confirmation request follows this event without a model call between them, and the answer
	// to the long-running call would be lost: ADK resumes from the confirmation answer alone.
	if len(event.Actions.RequestedToolConfirmations) > 0 {
		return false, llm.NewError("unsupported")
	}
	for _, call := range t.flagged {
		if call.ID == "" || call.Name == "" {
			return false, llm.NewError("invalid")
		}
		t.calls = append(t.calls, pausedCall{
			id:   call.ID,
			name: call.Name,
			request: Request{
				Kind: KindLongRunning,
				Tool: call.Name,
				Args: copyMap(call.Args),
			},
		})
	}
	t.pausedBy = t.author
	return true, nil
}

// unanswered reports a run that ended while long-running calls had no result event.
func (t *tracker) unanswered() bool { return t.calls == nil && len(t.flagged) > 0 }

// defaultResume approves or declines every confirmation, nothing else. The payload must be
// {"indexes": [...]} naming every request exactly once.
func defaultResume(requests []Request, action string, payload any) ([]Decision, error) {
	fields, ok := payload.(map[string]any)
	if !ok || len(fields) != 1 || (action != "approve" && action != "deny") {
		return nil, llm.NewError("invalid")
	}
	indexes, ok := fields["indexes"].([]any)
	if !ok || len(indexes) != len(requests) {
		return nil, llm.NewError("invalid")
	}
	seen := make([]bool, len(requests))
	for _, item := range indexes {
		number, ok := item.(float64)
		index := int(number)
		if !ok || float64(index) != number || index < 0 || index >= len(requests) || seen[index] {
			return nil, llm.NewError("invalid")
		}
		seen[index] = true
	}
	decisions := make([]Decision, len(requests))
	for index, request := range requests {
		if request.Kind != KindConfirmation {
			return nil, llm.NewError("invalid")
		}
		decisions[index] = Confirm(action == "approve")
	}
	return decisions, nil
}

// answerOf checks the decisions against the paused calls and returns the user message that
// answers them.
func answerOf(calls []pausedCall, decisions []Decision) (*genai.Content, error) {
	if len(decisions) != len(calls) {
		return nil, llm.NewError("invalid")
	}
	parts := make([]*genai.Part, len(calls))
	for index, call := range calls {
		decision := decisions[index]
		var response map[string]any
		switch {
		case call.request.Kind == KindConfirmation && decision.confirmed != nil && decision.response == nil:
			response = map[string]any{"confirmed": *decision.confirmed}
		case call.request.Kind == KindLongRunning && decision.confirmed == nil && decision.response != nil:
			encoded, err := json.Marshal(decision.response)
			if err != nil {
				return nil, llm.NewError("invalid")
			}
			if json.Unmarshal(encoded, &response) != nil || response == nil {
				return nil, llm.NewError("invalid")
			}
		default:
			return nil, llm.NewError("invalid")
		}
		parts[index] = &genai.Part{FunctionResponse: &genai.FunctionResponse{
			ID:       call.id,
			Name:     call.name,
			Response: response,
		}}
	}
	return &genai.Content{Role: genai.RoleUser, Parts: parts}, nil
}

// keepLossyPauses lifts the tree rule below. Only the evidence tests set it, to record what ADK
// does when a pause is not refused.
var keepLossyPauses = false

// resumesInPlace reports whether resuming a pause raised by the agent called name continues the
// run faithfully. ADK resumes only the agent that paused, so the work after it in the tree is
// lost unless that agent is the last leaf under every sequential ancestor; a pause inside a
// parallel or loop agent resumes without the surrounding iteration. An unknown or ambiguous name
// fails closed.
func (r *recorder) resumesInPlace(root agent.Agent, name string) bool {
	if keepLossyPauses {
		return true
	}
	var trail [][]agent.Agent
	found := 0
	var walk func(current agent.Agent, path []agent.Agent)
	walk = func(current agent.Agent, path []agent.Agent) {
		if current.Name() == name {
			found++
			trail = append(trail, append(slices.Clone(path), current))
		}
		for _, child := range current.SubAgents() {
			walk(child, append(path, current))
		}
	}
	walk(root, nil)
	if found != 1 {
		return false
	}
	chain := trail[0]
	for index, parent := range chain[:len(chain)-1] {
		next := chain[index+1]
		switch r.agents[parent].kind {
		case kindLLM:
		case kindSequential:
			children := parent.SubAgents()
			if children[len(children)-1] != next {
				return false
			}
		default:
			return false
		}
	}
	return true
}
