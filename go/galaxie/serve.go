// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

package galaxie

import (
	"context"

	"galaxie.invalid/galaxie/galaxie/bridge"
	"galaxie.invalid/galaxie/galaxie/llm"
)

// Serve registers the named entries with the page and blocks for the life of the Worker. A run
// names its entry; an unknown name fails "invalid". Under native Go it returns at once.
func Serve(entries map[string]Entry) {
	bridge.Serve(bridge.ReadBuildInfo(), func(ctx context.Context, request bridge.Request, caller llm.Caller) (string, error) {
		entry, ok := entries[request.Entry]
		if !ok {
			return "", llm.NewError("invalid")
		}
		return Execute(ctx, caller, entry, Input{Prompt: request.Prompt, Conversation: request.Conversation})
	})
}
