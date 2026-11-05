// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

//go:build !(js && wasm)

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// nativeHost answers capabilities in Go: "double" doubles, a negative value fails, and "hang"
// waits for the context.
type nativeHost struct{}

func (nativeHost) Capability(ctx context.Context, name string, value int) (int, error) {
	if name == "hang" {
		<-ctx.Done()
		return 0, ctx.Err()
	}
	if value < 0 {
		return 0, errors.New("the host rejected a negative value")
	}
	return value * 2, nil
}

// runAll runs every scenario with the native host and returns their records by name.
func runAll(ctx context.Context) (map[string]Result, error) {
	results := make(map[string]Result, len(scenarioNames))
	for _, name := range scenarioNames {
		result, err := runScenario(ctx, nativeHost{}, name)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		results[name] = result
	}
	return results, nil
}

// main prints the records as JSON; the file go/gate/expected.json is this output.
func main() {
	results, err := runAll(context.Background())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(results); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
