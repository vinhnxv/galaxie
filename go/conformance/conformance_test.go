// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

package conformance_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"

	"galaxie.invalid/galaxie/conformance/cases"
	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

const (
	scriptsPath = "../../tests/conformance/cases-adk-go/scripts.json"
	goldenDir   = "../../tests/conformance/golden-adk-go"
	// recordVariable switches the lane from comparing to recording the goldens.
	recordVariable = "GALAXIE_RECORD_ADK_GO"
)

// script is one case: the entry to run, the prompt and the page's scripted answers.
type script struct {
	Entry        string                       `json:"entry"`
	Prompt       string                       `json:"prompt"`
	Replies      []json.RawMessage            `json:"replies"`
	Capabilities map[string]capabilityOutcome `json:"capabilities"`
}

type capabilityOutcome struct {
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

// transcript is what the golden records: every request the program sent, in order, and its end.
type transcript struct {
	Requests     []json.RawMessage `json:"requests"`
	Responses    []json.RawMessage `json:"responses"`
	Capabilities []json.RawMessage `json:"capabilities"`
	Output       string            `json:"output"`
	Error        *failure          `json:"error"`
}

type failure struct {
	Code string `json:"code"`
}

// recorder plays the page: it answers from the script and writes down what the program sent.
type recorder struct {
	mu     sync.Mutex
	script script
	out    transcript
}

func (r *recorder) Call(_ context.Context, op string, payload []byte) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch op {
	case "model":
		r.out.Requests = append(r.out.Requests, json.RawMessage(payload))
		if len(r.script.Replies) == 0 {
			return nil, llm.NewError("unavailable")
		}
		reply := r.script.Replies[0]
		r.script.Replies = r.script.Replies[1:]
		var scripted struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(reply, &scripted) == nil && scripted.Error != "" {
			r.out.Responses = append(r.out.Responses, reply)
			return nil, llm.NewError(scripted.Error)
		}
		r.out.Responses = append(r.out.Responses, reply)
		return reply, nil
	case "capability":
		r.out.Capabilities = append(r.out.Capabilities, json.RawMessage(payload))
		var request llm.CapabilityRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, llm.NewError("invalid")
		}
		outcome, ok := r.script.Capabilities[request.Name]
		if !ok {
			return nil, llm.NewError("denied")
		}
		if outcome.Error != "" {
			return nil, llm.NewError(outcome.Error)
		}
		return outcome.Result, nil
	}
	return nil, llm.NewError("invalid")
}

func loadScripts(t *testing.T) map[string]script {
	t.Helper()
	data, err := os.ReadFile(scriptsPath)
	if err != nil {
		t.Fatal(err)
	}
	var scripts map[string]script
	if err := json.Unmarshal(data, &scripts); err != nil {
		t.Fatal(err)
	}
	return scripts
}

func indent(t *testing.T, value any) []byte {
	t.Helper()
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// normalize re-encodes raw JSON so key order and spacing never decide a comparison.
func normalize(t *testing.T, raw []byte) []byte {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return indent(t, value)
}

func TestNativeRunsMatchTheGoldens(t *testing.T) {
	entries := cases.Entries()
	scripts := loadScripts(t)
	names := make([]string, 0, len(scripts))
	for name := range scripts {
		names = append(names, name)
	}
	sort.Strings(names)
	record := os.Getenv(recordVariable) != ""
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			s := scripts[name]
			entry, ok := entries[s.Entry]
			if !ok {
				t.Fatalf("the script names the unknown entry %q", s.Entry)
			}
			page := &recorder{script: s, out: transcript{
				Requests:     []json.RawMessage{},
				Responses:    []json.RawMessage{},
				Capabilities: []json.RawMessage{},
			}}
			output, err := galaxie.Execute(context.Background(), page, entry, galaxie.Input{Prompt: s.Prompt, Conversation: "g1"})
			page.out.Output = output
			if err != nil {
				page.out.Error = &failure{Code: llm.CodeOf(err)}
			}
			golden := filepath.Join(goldenDir, name+".json")
			got := normalize(t, indent(t, page.out))
			if record {
				if err := os.WriteFile(golden, got, 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(golden)
			if err != nil {
				t.Fatalf("%v; run with %s=1 to record it", err, recordVariable)
			}
			if !bytes.Equal(normalize(t, want), got) {
				t.Fatalf("the native run differs from %s\nwant:\n%s\ngot:\n%s", golden, want, got)
			}
		})
	}
}
