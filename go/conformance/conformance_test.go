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
	scriptsPath    = "../../tests/conformance/cases-adk-go/scripts.json"
	goldenDir      = "../../tests/conformance/golden-adk-go"
	recordVariable = "GALAXIE_RECORD_ADK_GO"
)

type script struct {
	Entry  string `json:"entry"`
	Prompt string `json:"prompt"`
	Stream bool   `json:"stream"`
	// Answers reply, in order, to the pauses the run reaches.
	Answers      []answer                     `json:"answers"`
	Replies      []json.RawMessage            `json:"replies"`
	Capabilities map[string]capabilityOutcome `json:"capabilities"`
}

type answer struct {
	Action  string `json:"action"`
	Payload any    `json:"payload"`
}

type capabilityOutcome struct {
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

type transcript struct {
	Requests     []json.RawMessage `json:"requests"`
	Responses    []json.RawMessage `json:"responses"`
	Capabilities []json.RawMessage `json:"capabilities"`
	Pauses       []map[string]any  `json:"pauses,omitempty"`
	Output       string            `json:"output"`
	Error        *failure          `json:"error"`
}

type failure struct {
	Code string `json:"code"`
}

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
		reply = withoutChunks(reply)
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

// withoutChunks drops the text pieces a scripted reply streams through the page. Go receives only the
// aggregated reply, and the goldens record that.
func withoutChunks(reply json.RawMessage) json.RawMessage {
	var fields map[string]json.RawMessage
	if json.Unmarshal(reply, &fields) != nil {
		return reply
	}
	delete(fields, "chunks")
	stripped, err := json.Marshal(fields)
	if err != nil {
		return reply
	}
	return stripped
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

func normalize(t *testing.T, raw []byte) []byte {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return indent(t, value)
}

func TestNativeRunsMatchTheGoldens(t *testing.T) {
	definitions := cases.Definitions()
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
			definition, ok := definitions[s.Entry]
			if !ok {
				t.Fatalf("the script names the unknown entry %q", s.Entry)
			}
			page := &recorder{script: s, out: transcript{
				Requests:     []json.RawMessage{},
				Responses:    []json.RawMessage{},
				Capabilities: []json.RawMessage{},
			}}
			output, err := drive(t, page, definition, s, false)
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

// drive runs the prompt and answers each pause with the script's next answer. A pause with no answer
// left ends the drive with the run still waiting. With persist set, every run gets a store of its own
// and the conversation travels only as the record the previous run returned, as it does across a
// reload.
func drive(t *testing.T, page *recorder, definition galaxie.Definition, s script, persist bool) (string, error) {
	t.Helper()
	store := galaxie.NewStore()
	input := galaxie.Input{Prompt: s.Prompt, Conversation: "g1", Stream: s.Stream, Persist: persist}
	for next := 0; ; next++ {
		result, err := store.Run(context.Background(), page, definition, input)
		if err != nil || result.Pause == nil {
			if err == nil && persist && result.Record == nil {
				t.Fatal("a persisted run returned no record")
			}
			return result.Output, err
		}
		page.out.Pauses = append(page.out.Pauses, result.Pause.Request)
		if next >= len(s.Answers) {
			t.Fatalf("the run paused with no answer left in the script")
		}
		input = galaxie.Input{Conversation: "g1", Stream: s.Stream, Persist: persist, Resume: &galaxie.Resumption{
			InteractionID: result.Pause.ID,
			Action:        s.Answers[next].Action,
			Payload:       s.Answers[next].Payload,
		}}
		if persist {
			store = galaxie.NewStore()
			input.Restore = result.Record
		}
	}
}

// TestPersistedRunsMatchTheGoldens drives every scripted case again with each run in a fresh store
// that sees only the previous record, and requires the same transcript as the in-memory run: the
// stored conversation is as good as the live one.
func TestPersistedRunsMatchTheGoldens(t *testing.T) {
	definitions := cases.Definitions()
	scripts := loadScripts(t)
	names := make([]string, 0, len(scripts))
	for name := range scripts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			s := scripts[name]
			page := &recorder{script: s, out: transcript{
				Requests:     []json.RawMessage{},
				Responses:    []json.RawMessage{},
				Capabilities: []json.RawMessage{},
			}}
			output, err := drive(t, page, definitions[s.Entry], s, true)
			page.out.Output = output
			if err != nil {
				page.out.Error = &failure{Code: llm.CodeOf(err)}
			}
			want, readErr := os.ReadFile(filepath.Join(goldenDir, name+".json"))
			if readErr != nil {
				t.Fatal(readErr)
			}
			got := normalize(t, indent(t, page.out))
			if !bytes.Equal(normalize(t, want), got) {
				t.Fatalf("the persisted run differs from the golden\nwant:\n%s\ngot:\n%s", want, got)
			}
		})
	}
}
