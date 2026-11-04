// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

//go:build js && wasm

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"syscall/js"
)

// initEgress records what a network call made while the program initializes did. The loader
// replaces fetch before the first Go instruction, so a direct net/http call must be refused.
var initEgress = attemptEgress()

func attemptEgress() (outcome string) {
	defer func() {
		if recover() != nil {
			outcome = "blocked"
		}
	}()
	response, err := http.Get("http://127.0.0.1:9/egress")
	if err != nil {
		return "blocked"
	}
	_ = response.Body.Close()
	return "reached"
}

type settled struct {
	value js.Value
	err   error
}

// await blocks the calling goroutine until the promise settles or ctx ends. The callbacks stay
// alive after a cancel so a late settle never calls a released function.
func await(ctx context.Context, promise js.Value) (js.Value, error) {
	done := make(chan settled, 1)
	onValue := js.FuncOf(func(_ js.Value, args []js.Value) any {
		done <- settled{value: args[0]}
		return nil
	})
	onError := js.FuncOf(func(_ js.Value, args []js.Value) any {
		message := "the host call failed"
		if args[0].Type() == js.TypeObject && args[0].Get("message").Type() == js.TypeString {
			message = args[0].Get("message").String()
		}
		done <- settled{err: errors.New(message)}
		return nil
	})
	promise.Call("then", onValue, onError)
	select {
	case result := <-done:
		onValue.Release()
		onError.Release()
		return result.value, result.err
	case <-ctx.Done():
		go func() {
			<-done
			onValue.Release()
			onError.Release()
		}()
		return js.Undefined(), ctx.Err()
	}
}

// jsHost sends capability calls to the JavaScript side of the gate.
type jsHost struct{}

func (jsHost) Capability(ctx context.Context, name string, value int) (int, error) {
	promise := js.Global().Get("galaxieHost").Call("capability", name, value)
	result, err := await(ctx, promise)
	if err != nil {
		return 0, err
	}
	if result.Type() != js.TypeNumber {
		return 0, errors.New("the host returned a value that is not a number")
	}
	return result.Int(), nil
}

// runJS runs a scenario on its own goroutine and settles the returned promise with JSON.
func runJS(name string) js.Value {
	handler := js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					reject.Invoke(js.Global().Get("Error").New(fmt.Sprint(recovered)))
				}
			}()
			if name == "egress-http" {
				outcome := map[string]string{"init": initEgress, "http": attemptEgress()}
				encoded, _ := json.Marshal(outcome)
				resolve.Invoke(string(encoded))
				return
			}
			result, err := runScenario(context.Background(), jsHost{}, name)
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
				return
			}
			encoded, err := json.Marshal(result)
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
				return
			}
			resolve.Invoke(string(encoded))
		}()
		return nil
	})
	return js.Global().Get("Promise").New(handler)
}

func main() {
	names, _ := json.Marshal(scenarioNames)
	js.Global().Set("galaxieGate", map[string]any{
		"scenarios": string(names),
		"run": js.FuncOf(func(_ js.Value, args []js.Value) any {
			return runJS(args[0].String())
		}),
	})
	js.Global().Get("galaxieReady").Invoke()
	select {}
}
