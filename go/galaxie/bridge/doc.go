// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Package bridge connects a galaxie Go program to the page. It is the only package outside the
// gate that imports syscall/js, and only in its js/wasm files; every other galaxie package stays
// plain Go so it builds and tests natively.
//
// The page side is two JavaScript objects the Worker installs before the program starts:
// galaxieBridge.call(op, payload) answers a model or capability request with a JSON string and
// rejects with an Error whose message is a galaxie error code, and galaxieReady(info) reports that
// the program is ready. The program installs galaxieGo.run(request) and galaxieGo.cancel().
package bridge

import (
	"context"
	"encoding/json"
	"runtime/debug"

	"galaxie.invalid/galaxie/galaxie/llm"
)

// Request is one run the page asked for.
type Request struct {
	Entry        string `json:"entry"`
	Prompt       string `json:"prompt"`
	Conversation string `json:"conversation"`
	Stream       bool   `json:"stream,omitempty"`
	// Resume answers the pause a previous run ended with; the prompt is empty then.
	Resume *Resume `json:"resume,omitempty"`
	// Persist asks for the conversation's record; Restore hands a stored one back. Both are set
	// when the page keeps the conversation durably.
	Persist bool            `json:"persist,omitempty"`
	Restore json.RawMessage `json:"restore,omitempty"`
}

// Resume is the user's answer to a pause: the interaction it answers, the action and its payload.
type Resume struct {
	InteractionID string          `json:"interactionId"`
	Action        string          `json:"action"`
	Payload       json.RawMessage `json:"payload"`
}

// Paused reports a run that stopped to wait for the user. Request is the four-field interaction
// request the author built.
type Paused struct {
	InteractionID string         `json:"interactionId"`
	Request       map[string]any `json:"request"`
}

// Outcome is what a finished request produced: the final text, or the pause it ended with.
type Outcome struct {
	Output string
	Paused *Paused
	// Record is the persisted conversation: a JSON object the page stores and hands back.
	Record json.RawMessage
}

// Handler runs one request to completion or to a pause. caller reaches the page for model and
// capability calls.
type Handler func(ctx context.Context, request Request, caller llm.Caller) (Outcome, error)

// Module is a dependency version and checksum as recorded in the binary.
type Module struct {
	Version string `json:"version"`
	Sum     string `json:"sum"`
}

// BuildInfo is what the ready handshake reports. The page compares it with the reviewed lock file
// and refuses a binary built from other versions.
type BuildInfo struct {
	Go    string `json:"go"`
	ADK   Module `json:"adk"`
	GenAI Module `json:"genai"`
}

// ReadBuildInfo reads the toolchain and module versions the binary was built with.
func ReadBuildInfo() BuildInfo {
	info := BuildInfo{}
	built, ok := debug.ReadBuildInfo()
	if !ok {
		return info
	}
	info.Go = built.GoVersion
	for _, dependency := range built.Deps {
		module := Module{Version: dependency.Version, Sum: dependency.Sum}
		switch dependency.Path {
		case "google.golang.org/adk":
			info.ADK = module
		case "google.golang.org/genai":
			info.GenAI = module
		}
	}
	return info
}

func encodeResult(outcome Outcome, err error) string {
	type result struct {
		OK     bool            `json:"ok"`
		Output string          `json:"output,omitempty"`
		Paused *Paused         `json:"paused,omitempty"`
		Record json.RawMessage `json:"record,omitempty"`
		Code   string          `json:"code,omitempty"`
	}
	if err != nil {
		encoded, _ := json.Marshal(result{Code: llm.CodeOf(err)})
		return string(encoded)
	}
	encoded, _ := json.Marshal(result{OK: true, Output: outcome.Output, Paused: outcome.Paused, Record: outcome.Record})
	if len(encoded) > llm.MaxFrameBytes {
		encoded, _ = json.Marshal(result{Code: "unsupported"})
	}
	return string(encoded)
}
