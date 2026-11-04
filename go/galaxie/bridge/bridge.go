// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

//go:build js && wasm

package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"syscall/js"

	"galaxie.invalid/galaxie/galaxie/llm"
)

type page struct{}

func (page) Call(ctx context.Context, op string, payload []byte) ([]byte, error) {
	promise := js.Global().Get("galaxieBridge").Call("call", op, string(payload))
	result, err := Await(ctx, promise)
	if err != nil {
		var rejection *Rejection
		if errors.As(err, &rejection) {
			return nil, llm.NewError(rejection.Message)
		}
		return nil, err
	}
	if result.Type() != js.TypeString {
		return nil, llm.NewError("invalid")
	}
	return []byte(result.String()), nil
}

var (
	mu     sync.Mutex
	cancel context.CancelFunc
)

// Serve installs galaxieGo, reports the build to the page and blocks for the life of the Worker.
func Serve(info BuildInfo, handler Handler) {
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	js.Global().Set("galaxieGo", map[string]any{
		"run": js.FuncOf(func(_ js.Value, args []js.Value) any {
			return run(handler, args)
		}),
		"cancel": js.FuncOf(func(_ js.Value, _ []js.Value) any {
			mu.Lock()
			defer mu.Unlock()
			if cancel != nil {
				cancel()
			}
			return nil
		}),
	})
	encoded, _ := json.Marshal(info)
	js.Global().Get("galaxieReady").Invoke(string(encoded))
	select {}
}

// run starts the request on its own goroutine: a js.FuncOf callback must not block.
func run(handler Handler, args []js.Value) any {
	request := ""
	if len(args) > 0 && args[0].Type() == js.TypeString {
		request = args[0].String()
	}
	executor := js.FuncOf(func(_ js.Value, resolvers []js.Value) any {
		resolve := resolvers[0]
		go func() {
			defer func() {
				if recover() != nil {
					resolve.Invoke(encodeResult(Outcome{}, llm.NewError("executor_error")))
				}
			}()
			var parsed Request
			if err := json.Unmarshal([]byte(request), &parsed); err != nil {
				resolve.Invoke(encodeResult(Outcome{}, llm.NewError("invalid")))
				return
			}
			ctx, stop := context.WithCancel(context.Background())
			mu.Lock()
			cancel = stop
			mu.Unlock()
			defer func() {
				stop()
				mu.Lock()
				cancel = nil
				mu.Unlock()
			}()
			outcome, err := handler(ctx, parsed, page{})
			resolve.Invoke(encodeResult(outcome, err))
		}()
		return nil
	})
	promise := js.Global().Get("Promise").New(executor)
	executor.Release()
	return promise
}
