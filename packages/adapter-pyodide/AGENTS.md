# @galaxie/adapter-pyodide: coding guidance

## Purpose

Run a trusted LangGraph Python graph in a dedicated Pyodide Worker while model
routing, credentials, output checks and capability policy remain in JavaScript.
See the [README](README.md) and [Python ADR](../../docs/adr/0018-python-agents-through-pyodide.md).

## Entry points

- `createPyodideAdapter` and its host-facing types are exported from [src/index.ts](src/index.ts).
- `@galaxie/adapter-pyodide/worker` is the Worker entry. Only it imports Pyodide.
- [src/bridge.ts](src/bridge.ts) validates the closed JSON protocol without code generation.
- [src/runtime-files.ts](src/runtime-files.ts) binds the expected third-party wheel inventory.

## Do

- Supply a host-created module Worker through `createWorker`; the host owns its URL
  and Trusted Types policy.
- Route every model request through the run's `ModelPort` lease and every capability
  request through `CapabilityPort`.
- Check model output before sending it to Python and settle each lease once.
- Keep bridge failures fixed and content-free; validate every incoming and outgoing message.
- Preserve cancellation settlement. The 500 ms timer bounds Worker liveness only;
  core owns settlement waits.
- Preserve the module-Worker `importScripts` TypeError shim before loading Pyodide.

## Never

Do not import LangGraph.js or the LangGraph.js adapter, expose a credential to the
Worker, add a provider or policy implementation in Python, relax CSP, or copy spike code.
Do not add durable checkpoints or recovery without the separate contract work.

## Limits

Interrupts and resume use the Worker-owned in-memory saver, injected through
`galaxie.langgraph.checkpointer()`. Graphs must compile with that exact object.
Checkpoint persistence, streaming and subgraphs remain disabled. Lost Worker state
makes pending/resume fail `unavailable`; a fresh run can boot another Worker.
The adapter supports text-only, nonstreaming model calls. Python code
is trusted and can import `js`; a Worker is not an isolation boundary. CSP constrains
Worker requests, while a lint aid remains advisory. Runtime loader, WASM and standard
library bytes share the page build's trust; the adapter does not bind their bytes.
Third-party wheels are checked against hashes compiled into the Worker. Local wheels
and agent sources are trusted build outputs. See ADR-0018 decisions 9 and 10.

## Tests

Run the focused bridge and adapter tests with Vitest on Node and Chromium. Real
Pyodide tests need the explicitly fetched wheel cache and use only loopback assets.
The rag-browser CSP test checks installation and imports under the host's strict
header. Run `pnpm check` before reporting the integrated change as finished.
