// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"strings"
	"testing"

	"galaxie.invalid/galaxie/galaxie/llm"
)

func TestAResultAboveTheFrameLimitBecomesAFixedFailure(t *testing.T) {
	if got := encodeResult(Outcome{Output: "done"}, nil); got != `{"ok":true,"output":"done"}` {
		t.Fatalf("got %q", got)
	}
	// json.Marshal escapes "<" as six bytes, so this output tips over the limit once encoded.
	oversized := encodeResult(Outcome{Output: strings.Repeat("<", llm.MaxFrameBytes/2)}, nil)
	if oversized != `{"ok":false,"code":"unsupported"}` {
		t.Fatalf("got %d bytes", len(oversized))
	}
}

func TestAPausedOutcomeEncodesAsAPauseWithoutOutput(t *testing.T) {
	got := encodeResult(Outcome{Paused: &Paused{
		InteractionID: strings.Repeat("a", 64),
		Request:       map[string]any{"surfaceId": "main"},
	}}, nil)
	want := `{"ok":true,"paused":{"interactionId":"` + strings.Repeat("a", 64) + `","request":{"surfaceId":"main"}}}`
	if got != want {
		t.Fatalf("got %s", got)
	}
}

func TestAnOversizedPauseBecomesAFixedFailure(t *testing.T) {
	got := encodeResult(Outcome{Paused: &Paused{
		InteractionID: strings.Repeat("a", 64),
		Request:       map[string]any{"props": strings.Repeat("<", llm.MaxFrameBytes/2)},
	}}, nil)
	if got != `{"ok":false,"code":"unsupported"}` {
		t.Fatalf("got %d bytes", len(got))
	}
}

func TestAFailureWinsOverAPause(t *testing.T) {
	got := encodeResult(Outcome{Paused: &Paused{InteractionID: "x"}}, llm.NewError("denied"))
	if got != `{"ok":false,"code":"denied"}` {
		t.Fatalf("got %s", got)
	}
}
