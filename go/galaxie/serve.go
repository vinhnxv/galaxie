// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

package galaxie

import (
	"context"
	"encoding/json"

	"galaxie.invalid/galaxie/galaxie/bridge"
	"galaxie.invalid/galaxie/galaxie/llm"
)

// Serve registers the named entries with the page and blocks for the life of the Worker. A run
// names its entry; an unknown name fails "invalid". Under native Go it returns at once. An entry
// served this way cannot pause; ServeWith registers entries that can.
func Serve(entries map[string]Entry) {
	definitions := make(map[string]Definition, len(entries))
	for name, entry := range entries {
		definitions[name] = Definition{Build: entry}
	}
	ServeWith(definitions)
}

// ServeWith registers named definitions, their pause handling included, and blocks for the life
// of the Worker. One store serves every run, so an answer finds the session its pause left.
func ServeWith(definitions map[string]Definition) {
	store := NewStore()
	bridge.Serve(bridge.ReadBuildInfo(), func(ctx context.Context, request bridge.Request, caller llm.Caller) (bridge.Outcome, error) {
		definition, ok := definitions[request.Entry]
		if !ok {
			return bridge.Outcome{}, llm.NewError("invalid")
		}
		input := Input{Prompt: request.Prompt, Conversation: request.Conversation, Stream: request.Stream, Persist: request.Persist}
		if len(request.Restore) > 0 {
			input.Restore = request.Restore
		}
		if request.Resume != nil {
			var payload any
			if len(request.Resume.Payload) > 0 && json.Unmarshal(request.Resume.Payload, &payload) != nil {
				return bridge.Outcome{}, llm.NewError("invalid")
			}
			input.Resume = &Resumption{InteractionID: request.Resume.InteractionID, Action: request.Resume.Action, Payload: payload}
		}
		result, err := store.Run(ctx, caller, definition, input)
		if err != nil {
			return bridge.Outcome{}, err
		}
		if result.Pause != nil {
			return bridge.Outcome{Paused: &bridge.Paused{InteractionID: result.Pause.ID, Request: result.Pause.Request}, Record: result.Record}, nil
		}
		return bridge.Outcome{Output: result.Output, Record: result.Record}, nil
	})
}
