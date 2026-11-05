// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Package llm maps Google ADK model requests to the JSON messages galaxie's page side routes, and
// carries the per-run state that makes a galaxie failure end the run.
package llm

import (
	"context"
	"errors"
)

// messages repeats the fixed text of galaxie's error codes. Only these strings ever reach a model
// or an event; the page never sends free text across the bridge.
var messages = map[string]string{
	"invalid":         "The request is invalid.",
	"denied":          "Policy denied the request.",
	"unavailable":     "The requested service is unavailable.",
	"unreachable":     "The endpoint did not answer.",
	"unsupported":     "This operation is unsupported.",
	"budget_exceeded": "The budget limit was reached.",
	"timeout":         "The operation timed out.",
	"stale":           "The request targets stale state.",
	"duplicate":       "The submission was already accepted.",
	"fenced":          "Another owner controls the runtime.",
	"cancelled":       "The operation was cancelled.",
	"unrecoverable":   "Stored state cannot be recovered.",
	"outcome_unknown": "The outcome of an earlier call is unknown.",
	"executor_error":  "The executor or agent code failed.",
}

// Error is a galaxie failure: a code from the closed set and its fixed message.
type Error struct {
	Code string
}

// NewError returns the error for a code; an unknown code becomes "unavailable".
func NewError(code string) *Error {
	if _, ok := messages[code]; !ok {
		code = "unavailable"
	}
	return &Error{Code: code}
}

func (e *Error) Error() string { return messages[e.Code] }

// CodeOf classifies any error: a galaxie error keeps its code, a cancelled context is "cancelled"
// and everything else is "unavailable".
func CodeOf(err error) string {
	var galaxie *Error
	if errors.As(err, &galaxie) {
		return galaxie.Code
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return "unavailable"
}

// Recoverable reports whether a capability failure with this code is shown to the model as an
// error response. Every other code ends the run (ADR-0012).
func Recoverable(code string) bool {
	return code == "denied" || code == "invalid"
}
