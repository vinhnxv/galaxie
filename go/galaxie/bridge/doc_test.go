// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

package bridge

import (
	"strings"
	"testing"

	"galaxie.invalid/galaxie/galaxie/llm"
)

func TestAResultAboveTheFrameLimitBecomesAFixedFailure(t *testing.T) {
	if got := encodeResult("done", nil); got != `{"ok":true,"output":"done"}` {
		t.Fatalf("got %q", got)
	}
	// json.Marshal escapes "<" as six bytes, so this output tips over the limit once encoded.
	oversized := encodeResult(strings.Repeat("<", llm.MaxFrameBytes/2), nil)
	if oversized != `{"ok":false,"code":"unsupported"}` {
		t.Fatalf("got %d bytes", len(oversized))
	}
}
