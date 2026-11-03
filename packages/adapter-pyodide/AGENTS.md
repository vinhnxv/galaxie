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
Keep byte checkpoints on the host's scoped port; Python must never access IndexedDB.

## Limits

Interrupts, resume and checkpoints are enabled. `galaxie.langgraph.checkpointer()`
returns the exact saver graphs must compile with: `GalaxieCheckpointer` when the host
supplies `services.checkpoints: saver.byteRecords`, otherwise a Worker-owned memory
saver. Durable restore also needs `recovery: saver.recovery` in the same scope.
Without the port, lost Worker state makes pending/resume fail `unavailable`.
Streaming is enabled for bounded JSON graph projections and checked model deltas;
subgraphs preserve nested paths, child interrupts, resume and durable restore. Streams are live only and never replayed. Streamed model
calls require a provider declaring `streaming`, including implicit graph message
streaming from Python `ainvoke`. Growing text and final text are checked in JavaScript
before forwarding; earlier allowed deltas cannot be retracted after a block.
The adapter supports asynchronous text-only model calls and streaming. Python code
is trusted and can import `js`; a Worker is not an isolation boundary. CSP constrains
Worker requests, while a lint aid remains advisory. Runtime loader, WASM and standard
library bytes share the page build's trust; the adapter does not bind their bytes.
Third-party wheels are checked against hashes compiled into the Worker. Local wheels
and agent sources are trusted build outputs. See ADR-0018 decisions 9 and 10.

The `adk` framework (executor `adk-python`, ADR-0022) accepts only `LlmAgent`,
`SequentialAgent`, `ParallelAgent` and `LoopAgent` trees built from `galaxie.adk` models
and tools; a pause is allowed only in a leaf that is the last child under sequential
ancestors. Keep `subgraphs` false and keep the parallel-write replay test
(`tests/conformance/adk-python-agents.node.test.ts`) green when changing effect scopes.
Rebuild the wheel (`node scripts/build-python-wheels.ts`) after changing `python/galaxie`.

## Tests

Run the focused bridge and adapter tests with Vitest on Node and Chromium. Real
Pyodide tests need the explicitly fetched wheel cache and use only loopback assets.
The rag-browser CSP test checks installation and imports under the host's strict
header. Run `pnpm check` before reporting the integrated change as finished.
