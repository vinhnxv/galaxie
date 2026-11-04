# Go module

This directory holds the Go sources of galaxie's Google ADK (Go) executor ([ADR-0023](../docs/adr/0023-google-adk-go-through-a-wasm-worker.md), Proposed). Go compiles to WebAssembly (`GOOS=js GOARCH=wasm`) and runs in a dedicated Worker; policy stays in JavaScript.

| Path | Purpose |
| --- | --- |
| `go.mod`, `go.sum` | The module graph: `google.golang.org/adk` v1.9.0, `google.golang.org/genai` v1.57.0, toolchain `go1.27.3`. |
| `wasm.lock` | The supply-chain record: toolchain, build flags, every module in the wasm build with its license and checksum database record, the cutoff and the digest of `wasm_exec.js`. |
| `gate/` | The first-run gate: fourteen scripted ADK scenarios (`scenarios.go`) that the native test, the Node test and the headless Chromium test all execute, plus the wasm entry that bridges to JavaScript. `expected.json` is the native record (`go run ./gate`); the other lanes must reproduce it. It is a standalone program, not the galaxie package. |

## Commands

Install Go 1.27.3 (CI uses the version in `go.mod`). From the repository root:

- `pnpm run test:go` runs `go vet` for the native and wasm targets, `go test ./...` and `go mod verify`.
- `node scripts/build-go-wasm.ts ./gate` builds a main package to `.cache/go-wasm/` with the locked flags and prints its size and SHA-256. Two builds are byte-identical.
- `node scripts/fetch-go-glue.ts` copies the toolchain's `wasm_exec.js` into `.cache/go-wasm/` after its digest matches `wasm.lock`.
- `node scripts/check-go-lock.ts --update` regenerates `wasm.lock` after a deliberate dependency change. It needs the network (the checksum database and the public module index) and the Go module cache.

## Rules

- Only `go/galaxie/bridge` and `go/gate` import `syscall/js`; a repository test enforces it.
- Go sources carry the same SPDX header as the TypeScript sources, written as comments.
- The release-age cutoff is fixed in `wasm.lock`. A newer module version waits for the next cutoff, as for the Python wheels.
- Never add a `replace` directive or a `go.work` file to this module; the lock covers the pinned graph only.
