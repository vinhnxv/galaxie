# @galaxie/adapter-go: coding guidance

## Purpose

Host Google ADK (Go) agents compiled to WebAssembly as a galaxie executor (`adk-go`). Go runs in a
dedicated Worker; routing, labels, consent, budgets, credentials, output checks and authorization
stay in JavaScript. See the [README](README.md), the [Go module](../../go/README.md) and
[ADR-0023](../../docs/adr/0023-google-adk-go-through-a-wasm-worker.md) (Proposed).

## Entry points

- [src/index.ts](src/index.ts) exports `createGoAdapter`, the host types and the executor id.
- [src/adapter.ts](src/adapter.ts) is the adapter: it validates the agent, boots one Worker per prepare
  and runs start commands, draining stream events ahead of the outcome. Resume fails `unsupported`.
- [src/bridge.ts](src/bridge.ts) serves the Worker's `call` messages; [src/llm.ts](src/llm.ts) checks and
  routes model calls through `host.langchain.chatModel(role)`, and capability calls through the broker.
- [src/stream.ts](src/stream.ts) projects checked text into `messages` deltas and tool markers into
  `updates` events and joins streamed provider chunks; [src/tool-calls.ts](src/tool-calls.ts) builds the
  text the output check sees.
- [src/loader.ts](src/loader.ts) runs inside the Worker: fetch, length and SHA-256 check, egress stubs,
  compile, instantiate and the ready handshake. [src/worker.ts](src/worker.ts) is its entry.
- [src/protocol.ts](src/protocol.ts) holds the boot and status messages shared by both sides.

## Do

- Check the module's length and SHA-256 before `WebAssembly.compile`; every failure is the same
  fixed `unavailable` error.
- Install the egress stubs before the first Go instruction and discard Go standard output.
- Keep `syscall/js` out of this package's Go counterparts except `go/galaxie/bridge` and `go/gate`.

## Never

Do not import another executor adapter, LangGraph, Pyodide or `@google/adk`. Do not name Go or ADK in
`packages/core`. Do not relax CSP or Trusted Types, add `unsafe-eval`, or let a run reach the network.
`scripts/check-dependencies.ts` enforces the import rules.

## Limits

Interactions, resume and durable sessions are not built yet; their feature flags are false and those
paths fail `unsupported`. Streaming is opt-in per agent (`stream: true`); Go receives only the final
reply of each model call. A cancelled run is given 500 ms to finish, then its Worker is terminated
and the session is unrecoverable. The stubs guard against accidental network use; Go code
is trusted and can reach anything `syscall/js` reaches, so they are not an isolation boundary.

## Tests

Run `pnpm exec vitest run packages/adapter-go tests/conformance/adk-go.node.test.ts tests/conformance/adk-go-run.node.test.ts
tests/conformance/adk-go-scan.node.test.ts
tests/conformance/check-dependencies.node.test.ts examples/rag-browser/test/go-gate.node.test.ts
examples/rag-browser/test/adk-go-reference.node.test.ts` and `pnpm run test:go`. `test/loader.node.test.ts`
covers the verify-before-compile order, the egress stubs and the exit handshake;
`test/adapter.node.test.ts` covers validation, Worker lifetime and the unsupported run;
`test/adk-go.node.test.ts` runs the adapter against a scripted Worker; `test/stream.test.ts` has the
validator, splitter and joiner tables. The gate test
needs Go and builds the gate module itself. Run `pnpm check` before reporting the integrated change
as finished.
