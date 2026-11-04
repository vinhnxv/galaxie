// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

//go:build js && wasm

package bridge

import (
	"context"
	"syscall/js"
)

// Rejection is a promise the page rejected; Message is the galaxie error code it carried.
type Rejection struct {
	Message string
}

func (r *Rejection) Error() string { return r.Message }

type settled struct {
	value js.Value
	err   error
}

// Await blocks the calling goroutine until the promise settles or ctx ends. The callbacks stay
// registered after a cancel and are released when the late settle arrives, so the page never
// invokes a released function. It must not run on the goroutine of a js.FuncOf callback.
func Await(ctx context.Context, promise js.Value) (js.Value, error) {
	done := make(chan settled, 1)
	onValue := js.FuncOf(func(_ js.Value, args []js.Value) any {
		done <- settled{value: args[0]}
		return nil
	})
	onError := js.FuncOf(func(_ js.Value, args []js.Value) any {
		message := ""
		if len(args) > 0 && args[0].Type() == js.TypeObject && args[0].Get("message").Type() == js.TypeString {
			message = args[0].Get("message").String()
		}
		done <- settled{err: &Rejection{Message: message}}
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
