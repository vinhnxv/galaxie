# @galaxie-ai/adapter-pyodide: coding guidance

## Purpose

Run a trusted LangGraph Python graph in a dedicated Pyodide Worker while model
routing, credentials, output checks and capability policy remain in JavaScript.
See the [README](README.md) and [Python ADR](../../docs/adr/0018-python-agents-through-pyodide.md).

## Entry points

- `createPyodideAdapter` and its host-facing types are exported from [src/index.ts](src/index.ts).
- `@galaxie-ai/adapter-pyodide/worker` is the Worker entry. Only it imports Pyodide.
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
The LangGraph proxy supports asynchronous text-only model calls and streaming;
model-chosen calls use the measured [text-protocol replacement](README.md#langgraph-python-model-chosen-calls-through-text).
Native tool calls remain refused. `bind_tools` and default structured output
raise fixed `unsupported`, also catchable as `NotImplementedError`, at construction
or run. Ordinary author tool bodies may call capabilities with `tool=True` to
retain the adapter binding check; preserve default ToolNode error handling.
Broker `invalid` also denotes binding errors, so never turn it into schema-only
model text. Text-protocol reload passes local Chromium, Firefox and WebKit
measurements; streamed metadata and arbitrary crash recovery remain refused. The execution-identity rerun preserves
swallowed codes test-locally but refuses promotion after read-identity and abrupt
recovery failures; a parked sibling confirmation also survives the latch. Keep
the candidate test-only; see the [decision and limits](../../docs/adr/0018-python-agents-through-pyodide.md#execution-identity-rerun-2026-11-13).
Other Python faces support routed
schema-constrained replies. A bridge `repairAttempt` must be a positive safe integer beside
`jsonSchema`; forward it to `ModelPort.begin` so native-output retries consume the
host's route and run repair limits. Python code
is trusted and can import `js`; a Worker is not an isolation boundary. CSP constrains
Worker requests, while a lint aid remains advisory. Runtime loader, WASM and standard
library bytes share the page build's trust; the adapter does not bind their bytes.
Third-party wheels are checked against hashes compiled into the Worker. Local wheels
and agent sources are trusted build outputs. See ADR-0018 decisions 9 and 10.

The `adk` framework (executor `adk-python`, ADR-0022) accepts only `LlmAgent`,
`SequentialAgent`, `ParallelAgent` and `LoopAgent` trees built from `galaxie.adk` models
and tools. A leaf may pause under sequential ancestors at any child position; a single
pausing agent beneath each Parallel ancestor may ask for confirmation. Loop pauses,
long-running Parallel tools and transfer pauses stay refused. Newly enabled positions
use ADK resumability and refuse `temp:` output keys and
`LlmAgent` transfer children; original last-child sequences keep their runner.
Keep `subgraphs` false and keep the parallel-write replay test
(`tests/conformance/adk-python-agents.node.test.ts`) green when changing effect scopes.
Rebuild the wheel (`node scripts/build-python-wheels.ts`) after changing `python/galaxie`.

ADK Python also accepts exact declared-role strings through the optional ADK-only
boot inventory (at most 256 roles, 1–128 characters). Keep whole-tree validation
before verified model assignment, fixed failure codes and the Gemini-name guard.
Each prepare owns a fresh interpreter; this trusted declaration is not isolation.
`galaxie.adk.toolset` admits only fixed same-boot capability tools; preserve order,
duplicate checks and flattened pause scanning. Native, dynamic and foreign
toolsets, built-ins, planners and code executors remain refused.

## Tests

Run the focused bridge and adapter tests with Vitest on Node and Chromium. Real
Pyodide tests need the explicitly fetched wheel cache and use only loopback assets.
The rag-browser CSP test checks installation and imports under the host's strict
header. Run `pnpm check` before reporting the integrated change as finished.
