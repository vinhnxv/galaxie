// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !(js && wasm)

package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

// TestScenariosMatchTheRecordedResults is the native half of the gate: the Node and browser runs
// must produce the same records, byte for byte.
func TestScenariosMatchTheRecordedResults(t *testing.T) {
	recorded, err := os.ReadFile("expected.json")
	if err != nil {
		t.Fatal(err)
	}
	results, err := runAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var want map[string]json.RawMessage
	if err := json.Unmarshal(recorded, &want); err != nil {
		t.Fatal(err)
	}
	if len(want) != len(scenarioNames) {
		t.Fatalf("expected.json has %d scenarios, the gate runs %d", len(want), len(scenarioNames))
	}
	for _, name := range scenarioNames {
		got, err := json.Marshal(results[name])
		if err != nil {
			t.Fatal(err)
		}
		var compact json.RawMessage
		if err := json.Unmarshal(want[name], &compact); err != nil {
			t.Fatal(err)
		}
		wantBytes, _ := json.Marshal(compact)
		if string(got) != string(wantBytes) {
			t.Errorf("%s:\n got  %s\n want %s", name, got, wantBytes)
		}
	}
}
