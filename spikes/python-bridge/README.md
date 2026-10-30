# Python worker bridge feasibility spike

Throwaway evidence for [ADR-0018](../../docs/adr/0018-python-agents-through-pyodide.md)
and Beads `galaxie-3r5.12`. Nothing here is package implementation. The
`galaxie-6h5` package-development gate remains separate.

## Reproduce

From the repository root, with Node 24, pnpm 11, Python 3 and Playwright's
Chromium installed:

```sh
pnpm --dir spikes/python-bridge install --frozen-lockfile
python3 spikes/python-bridge/standins.py
node spikes/python-bridge/probe.mjs
pnpm --dir spikes/python-bridge record
```

Internet access to the Pyodide CDN and PyPI is required. The recorder starts a
loopback Vite server and closes it and Chromium on exit. `worker.mjs` runs in a
Node `worker_threads.Worker` and a browser dedicated module Worker. Both load
Pyodide **314.0.7**, LangGraph **1.2.18**, langchain-core **1.7.3**,
langgraph-checkpoint **4.3.1** and pydantic-ai-slim **2.63.0**. The npm lockfile
pins JS dependencies; `requirements.json` pins all resolved Python dependencies
besides micropip (pinned by Pyodide), the explicitly hash-pinned uuid-utils wheel,
and the locally generated ormsgpack stand-in. Result inventories include every
installed Python distribution and SHA-256 hashes of fetched response bodies.
Those recorded hashes are evidence, not a signed artifact inventory or runtime
SRI enforcement.

The dependency probe uses a separate fresh Node worker and no stand-ins. Run it
before the functional recorder to reproduce the initial resolver failures and
the successful pydantic-ai/httpx2 imports. It writes `dependency-probe.json`.

## Observed paths

Both hosts pass the same assertions in `agent.py` and `host.mjs`:

| Path | Node | Headless Chromium |
| --- | --- | --- |
| Real Python LangGraph invokes `GalaxieChatModel` through JSON RPC to the existing JS `MockChatModel` | Pass | Pass |
| Read-only `math.double@1` capability returns 42, forwarding the full `metadata.langgraph_checkpoint_ns` | Pass | Pass |
| `request_interaction(request, config)` carries exactly `surfaceId`, `viewRevision`, `component`, `props`; `aget_state()` supplies the interrupt ID | Pass | Pass |
| `Command(resume={interrupt_id: submission})` completes the graph; only the interrupting node runs twice | Pass | Pass |
| pydantic-ai `Agent` runs with a real `Model` subclass, makes a tool call over the same bridge and returns the second mock reply | Pass, two model requests | Pass, two model requests |
| Abort during an outstanding model call aborts the JS mock and settles the LangGraph task with fixed `cancelled` | Pass | Pass |
| Unknown bridge version rejected with fixed content-free `invalid` | Pass | Pass |
| Tight synchronous Python loop leaves the host responsive; worker does not acknowledge abort; host requests worker termination | Observed | Observed |

The fixtures contain synthetic text only. The LangGraph graph stores checkpoints
with Python's `InMemorySaver` and exercises serialization through the stand-in.
The capability is a narrow read-only JS fixture. The model is the existing
deterministic mock imported from `packages/models`, not a new fake Python model.
The pydantic-ai proxy deliberately maps its two known request phases to scripted
prompts; this is not a general message, multimodal, tool-schema or history
translator. It does not implement `request_stream`. Framework instrumentation is
disabled (`LANGSMITH_TRACING=false`, `LANGCHAIN_TRACING_V2=false`, and
`agent.instrument = False`). No exporter is registered.

## Measurements

The authoritative values are in [summary.json](summary.json); full per-host
transcripts, distribution inventories and fetch ledgers are in
[node-result.json](node-result.json) and
[chromium-result.json](chromium-result.json). The measured machine is an Apple
M5 Pro, macOS arm64, Node 24.15.0 and headless Chromium 156.0.8078.4.

| Measurement | Node | Headless Chromium |
| --- | ---: | ---: |
| Runtime initialization | 808.4 ms | 871.0 ms |
| Cold agent ready | 5,473.6 ms | 5,328.3 ms |
| Bridged graph abort settlement | 0.86 ms | 0.80 ms |
| Fetched response bodies | 14,294,410 bytes | 26,557,342 bytes |
| Fetched wheel bodies, including repeats | 9,429,400 bytes | 9,429,400 bytes |
| Distinct wheel bodies | 9,429,400 bytes | 9,429,400 bytes |

Each sample starts a new worker and interpreter; Node uses a new native-package
cache directory and Chromium a new browser context. The Pyodide npm distribution
is already installed and served from loopback for Chromium, so this is not an
empty-machine npm installation or a CDN end-to-end page-load benchmark. CDN/OS
caches can be warm. Timing includes fetch-body hashing and package metadata
resolution; no p50/p95, mobile, memory or long-task measurements were taken.

`runtimeMs` measures importing and initializing Pyodide inside the worker.
`coldStartMs` starts before sending boot and ends after all wheel installation,
framework imports and agent construction. The host handler is registered before
the boot command. The worker-constructor-to-handler interval is excluded.

The runtime files total **13,531,207 bytes**. The distinct wheel bodies total about
**9.43 MB** in each host, including the stand-in: about **23 MB** for runtime
files plus distinct wheels. `uniqueWheelBodyBytes` counts each wheel digest once;
`fetchedWheelBodyBytes` also counts repeated fetches during dependency resolution.
Exact byte counts and hashes are recorded, with MB meaning 1,000,000 bytes. The additional metadata, source and runtime fetches are
reported separately as `fetchedResponseBodyBytes`. That field is a sum of
decoded response-body sizes observed by worker `fetch`, including repeated
requests; it is **not** compressed network traffic. Node loads the runtime files
from disk; Chromium fetches the WASM, standard library and lockfile. Module
imports bypass that fetch wrapper, so use `runtimeFiles` for their file sizes.
Do not add Chromium's fetched runtime bodies to `runtimeFileBytes` again.

`abortMs` measures host abort through Python graph settlement while awaiting RPC.
The synchronous-loop probe deliberately leaves a 30 ms host timer before
termination: `forcedTerminationMs` includes that timer, and Chromium's
`Worker.terminate()` has no completion acknowledgment. This proves host
responsiveness and a termination request, not precise browser termination
latency or a durable checkpoint after termination.

## Every dependency gap and its resolution

| Package / integration | Observed result | Resolution in the functional run |
| --- | --- | --- |
| `uuid-utils` | Not in Pyodide's package list. Initial langchain-core resolution reports unsatisfied `langsmith`; selecting a compatible uuid-utils first allows it to install. | Real upstream **0.19.0** `cp310-abi3-pyemscripten_2026_0_wasm32` wheel from PyPI, explicitly pinned by URL and SHA-256. `micropip.install('uuid-utils==0.19.0')` also succeeds. No stand-in. |
| `ormsgpack` | No matching Pyodide wheel; both direct install and langgraph-checkpoint resolution fail. | Same-name **1.13.0** pure-Python wheel built by `standins.py`, using `msgpack.fallback` from Pyodide's **1.1.2** distribution. No copied upstream implementation. |
| `httpx2` | **2.16.0** installs and imports. On Emscripten it selects **httpx2-jsfetch 1.0**, not native httpcore2. | Upstream pure-Python wheels; no stand-in. Only import and the custom-model agent path tested; no Python HTTP request. |
| pydantic-ai dependencies absent from the Pyodide list | `griffelib` **2.4.1**, `genai-prices` **0.2.0**, `pydantic-graph` **2.63.0**, `opentelemetry-api` **1.45.2**, and transitive `logfire-api` **5.4.0** install/import. | Upstream pure-Python wheels; no stand-ins. Exact remaining transitive versions are in both result inventories. |
| Native transitive dependencies | `pydantic_core` **2.41.5**, `xxhash` **3.6.0**, `orjson` **3.11.8**, `zstandard` **0.25.0**, `cffi` **2.0.0**, and PyYAML **6.0.3** are supplied by pinned Pyodide. | Pyodide wheels; no custom native build. |
| Pyodide Node worker stdout/stderr | Default fd-based output fails in `worker_threads` (`fd` is undefined). | Explicit JS stdout/stderr callbacks in both worker entry points. |
| Browser runtime asset location | Vite dependency optimization moves the loader away from its adjacent runtime files. | Serve the pinned runtime files together, set `indexURL`, and exclude Pyodide from optimization. |

The ormsgpack stand-in implements only the used `packb`, `unpackb`, `Ext`, error
alias and option names. It round-trips the state, checkpoint tasks and interrupt
in this graph. It does not establish ormsgpack wire compatibility, surrogate
replacement, enum passthrough semantics, arbitrary Python object support,
performance or cross-version durable restore. Production must build a real
wheel or separately qualify a replacement; this stand-in must not be promoted.

pydantic-ai 2.63.0 also differs from older examples: constructor
`instrument=False` is rejected; the supported instance property disables it.
`AgentRunResult.usage` is a property, not a method. These were fixture API
corrections, not package replacements.

## Core contract findings and verdict

Basic worker execution is feasible on both hosts. Keep ADR-0018 **Proposed,
revised after this spike**; this is not a production adapter or Python parity
receipt. The use-case gate and the twelve CPython/Pyodide parity cases remain
open.

No change to `ExecutorAdapter`, `ModelPort`, `CapabilityPort`, the four-field
`InteractionRequest` or `effectScope` is required by these observed paths. A
real adapter would call `ModelPort.begin`, check output and settle leases on the
JS side, and invoke the existing broker; this harness does not compose core or
prove routing, budgets, consent, labels, output safety or write recovery.

One planned guarantee **does require a core contract change**: executor-aware
session restore. `RecoverySession` currently has only `agentId` and
`agentVersion`, and `validateSession` rejects any third field. Adding executor
identity/version needs a compatibility design and migration across core and
storage. ADR-0018's original statement that `RecoveryStore` stays unchanged
cannot hold unchanged alongside that guarantee. No such change is made here.

The opaque byte-record storage port is also new work. It must retain app and
principal scoping, fencing, logout generations, retention, deletion and export.
It was not implemented or measured. Synchronous Python cannot receive an abort
message while busy; any production disposal design must coordinate worker
termination, JS-side in-flight results and checkpoint commits while preserving
core's existing settlement ownership. This probe does not establish that design
or justify weakening the contract.

The JSON draft uses version, kind, correlation ID, operation and plain JSON
payloads; explicit abort messages; and fixed error codes/messages. It rejects
the tested unknown version. It has no production run/session generation
fencing, full schema goldens, streaming/backpressure or exhaustive malformed
payload coverage. Pyodide's private function binding is only transport plumbing;
model/capability payloads and replies are JSON strings, not JS proxy data.

Runtime SRI enforcement, CPython parity, real providers, credential/span scans,
browser CSP deployment, persistent checkpoints, recovery fault tests and
complete message mapping remain unverified. Python can still import `js` and
bypass this fixture: a dedicated worker is not an isolation boundary.

## Repository validation

`pnpm check` passed after the final spike run: license checks, Biome, both
TypeScript compiler lanes, 2,750 passing tests (75 skipped), builds, dependency
checks and document links. The first full run had one 5,000 ms timeout in the
existing host-local cached-document lifecycle test; that test passed in
isolation (96 ms) and in the full rerun. No test timeout or package code was
changed. A separate read-only review checked the feasibility paths and
measurement boundaries; its wheel timestamp and browser termination-reporting
findings were addressed.
