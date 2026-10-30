# ADR-0018: Python agents through Pyodide in a worker, with policy kept in JavaScript

- **Status:** Proposed
- **Date:** 2026-10-30
- **Related:** brief §6.2, §7.4, §7.5, §16.2, §16.7; ADR-0002, ADR-0003, ADR-0005, ADR-0006, ADR-0012, ADR-0016, ADR-0017
- **Revisions:** 2026-10-30: added pydantic-ai as the second framework, ahead of DSPy, and the rule for framework-owned instrumentation.
  2026-10-30: recorded the use case that opened the brief §16.7 gate.
  2026-10-30: designed the executor-aware `RecoverySession` contract in decision 7.
  2026-10-30: worker spike passed the basic LangGraph and pydantic-ai paths on Node and Chromium; retained Proposed status, revised the dependency assessment and identified the executor-aware recovery contract change.

## Context

Agent authors ask for Python frameworks: LangChain and LangGraph for Python, pydantic-ai, DSPy, CrewAI and others. Brief §7.4 places Python in the Experimental tier, and §16.7 gates it on a use case strong enough to pay the compatibility cost. This ADR fixes the boundary a Python executor would use, so that a spike can test it and the gate decision can be made with evidence.

The maintainer opened the §16.7 gate on 2026-10-30 with this use case: port an existing LangGraph Python "language tutor" agent to galaxie without rewriting its graph logic, and remove its agent backend. LangGraph Python is the first framework and pydantic-ai the second. The port succeeds when the agent's graph runs unchanged apart from model and tool wiring and passes the Python parity lane against CPython (decision 13).

Runtimes considered:

- **Wasmtime** is a native WebAssembly runtime for servers and desktops. It does not run in a browser, and running it would need a native host process, which the mission excludes (brief §0.3).
- **Pyodide** is CPython built with Emscripten. Pyodide 314.0.7 ships prebuilt `pydantic_core`, `xxhash`, `orjson`, `tiktoken`, `httpx`, `openai`, `numpy` and `aiohttp` [S4].
- **componentize-py with jco** compiles Python to a WASI 0.2 component and transpiles it to JavaScript. Imports resolve only at build time, every native extension needs a WASI build, and jco calls its browser support experimental.

Required dependencies checked on PyPI against the Pyodide package list on 2026-10-30:

| Framework | Missing from Pyodide | Assessment |
| --- | --- | --- |
| `langchain-core` 1.7.3 | `uuid-utils` (Rust) | Upstream 0.19.0 Pyodide wheel verified; select it before resolving langchain-core |
| `langgraph-checkpoint` 4.3.1 | `ormsgpack` (Rust) | One wheel to build or replace |
| `pydantic-ai-slim` 2.63.0 | `opentelemetry-api`, `griffelib`, `genai-prices`, `pydantic-graph`, `httpx2` | Upstream wheels installed/imported in both workers; httpx2 2.16.0 selects httpx2-jsfetch 1.0 on Emscripten |
| `dspy` 3.4.1 | `litellm` and its dependencies | Needs a stand-in; inference only |
| `crewai` 1.15.33 | `chromadb`, `lancedb`, `tokenizers`, `aiosqlite` and others | Not feasible without a fork |

Every galaxie guarantee is enforced in `@galaxie/core` and the JavaScript providers: routing, consent, labels, budgets, private-string guards, output safety, recovery and storage fencing. ADR-0017 says a second framework gets its own executor adapter and must pass its conformance suite without changes to the core contracts. ADR-0003 keeps the JavaScript executor on the main thread.

## Decision

1. **Runtime.** Python agents run on a pinned Pyodide release. Its files load from the host's CDN or object storage with SRI, under the same rules as other runtime artifacts. Wasmtime is not used. componentize-py and jco stay on the watch list as a path to isolated guests (brief §16.7).
2. **Placement.** Each Python agent instance runs Pyodide in its own dedicated Worker. Core, the broker, the router, providers and host bindings stay on the main thread under ADR-0003. Interpreter startup, imports and Python node code are synchronous and cannot yield cooperatively, so they must not run on the main thread. This is a scoped exception for the Python executor; the JavaScript executor keeps ADR-0003.
3. **Boundary.** A new JavaScript package, `@galaxie/adapter-pyodide`, implements `ExecutorAdapter`. A Python package, imported as `galaxie`, contains proxies only: `galaxie.langchain` (chat model and tools), `galaxie.langgraph` (checkpointer and `request_interaction`) and, later, `galaxie.pydantic_ai` (model and tools) and `galaxie.dspy` (LM). The Python side holds no credential, provider, policy, budget or label logic. Each guarantee keeps its single JavaScript implementation.
4. **Model calls.** `GalaxieChatModel`, the pydantic-ai `GalaxieModel` (a `pydantic_ai.models.Model` implementing `request` and `request_stream`) and the DSPy LM send the role, messages and options over the bridge. JavaScript performs the call through the routed model path, including consent, reservation, the credential lease, output safety on every chunk and usage settlement, then returns the checked reply or chunks. Python never receives a credential or unchecked model text.
5. **Bridge.** Worker messages carry plain JSON under a versioned schema, `galaxie.bridge/v1`. Messages and tool calls use a fixed shape close to the OpenAI-compatible chat format. No JavaScript proxy objects pass into Python. Abort signals cross as explicit messages. Errors cross as fixed `GalaxieError` codes and messages with no content. Unknown or malformed messages are rejected on both sides.
6. **Capabilities.** `host.capabilities.call(name, input, config)` forwards to `CapabilityPort.call`. The adapter takes `effectScope` from `langgraph_checkpoint_ns`, as the LangGraph.js adapter does, so recovery write IDs keep the same task-namespace rule (AT-35).
7. **Checkpoints.** `@galaxie/storage-indexeddb` gains an opaque byte-record port with the same app/principal scoping, app-epoch and logout-generation fencing, retention, deletion and export rules as the existing saver. The Python checkpointer stores LangGraph Python's serialized checkpoints and writes through it. The submission inbox and effect-journal operations need no change. Session identity needs one, because the spike found that `RecoverySession` holds only the agent ID and version and rejects extra fields. Without the executor, a session written by one executor and restored by another with the same agent ID and version would read as fresh, and accepted answers and journalled effects would be reconciled against a different graph. The change, implemented with `@galaxie/adapter-pyodide` and not before:
   - `RecoverySession` becomes `{ agentId, agentVersion, executorId }`, all required non-empty strings. Core writes `executorId` from `ExecutorAdapter.id`, and its validator requires exactly these three keys.
   - The adapter version is not recorded, so an adapter release never strands sessions. An adapter that cannot read its own older checkpoints fails `unsupported` from `pending()`, or takes a new `id` for a permanent format change.
   - Both identity checks compare all three fields. A start-time mismatch keeps failing `unavailable`. A restore-time executor mismatch fails `unsupported` with the fixed message "The saved session uses a different executor.", reports `restore_failed`, and makes no `pending()` call or inbox reconciliation. Errors and diagnostics carry no identifiers.
   - `@galaxie/storage-indexeddb`, which is already the LangGraph.js saver, reads a stored two-key record as `executorId: 'langgraph-js'`, the only executor that existed when it was written. New writes always have three keys. The record envelope stays `v: 1`, with no database version change and no rewrite. Core never names a framework (ADR-0017).
   - Every other `RecoveryStore` must return three keys; in this repository that is only the in-memory test store. This breaks the port, which is acceptable while all packages are private and unreleased.
   - `galaxie.session-export/1` adds `executorId` to `metadata.agent`. The field is additive and no import exists, so the format name is unchanged.
   - Older code reads a three-key record as `corrupt` and marks the session unrecoverable. A release before 1.0 must therefore ship readers that accept both shapes before any build writes three keys.
8. **Interrupts.** `request_interaction(request, config)` wraps LangGraph Python's `interrupt()` with the same four-field request. The adapter's `pending()` reads it through `get_state` over the bridge. The LangGraph.js limits still apply: one interrupt ID per pending state, no parallel interrupts, no static breakpoints.
9. **Trust.** Python agent code is trusted, as JavaScript agent code is (ADR-0002). Python can still import `js` and call `fetch` from the worker. The worker has no DOM, but that is not an isolation boundary. Removing network globals after packages load is a mitigation only. A Python lint aid flags `import js`, `pyodide.http`, `urllib`, `socket`, direct provider SDKs and provider-prefixed model strings such as `Agent('openai:…')`, with the same limits as the ESLint plugin.
10. **Packages.** A Python agent ships its wheels and a hash-locked lockfile, and the generated manifest's SHA-256 inventory covers them. Missing compiled dependencies get either Pyodide wheels built with `pyodide-build` and hosted with pinned hashes, or same-name pure-Python stand-ins. Both are pinned to exact upstream versions. galaxie does not fork Pyodide.
11. **Framework order.** LangGraph Python with LangChain models and tools comes first. pydantic-ai comes second, installed as `pydantic-ai-slim` so no provider SDK ships. Its tools wrap `host.capabilities.call`, and its structured output is validated in Python after JavaScript has checked the raw text. It declares `interrupts: false` and `checkpoints: false` until its deferred tool calls have a designed and tested mapping to galaxie interactions and `pydantic-graph` persistence uses the byte-record port. DSPy comes third, with the same feature flags and a `litellm` stand-in. CrewAI stays in the Remote tier.
12. **Framework instrumentation.** Framework-owned tracing stays off. pydantic-ai's OpenTelemetry instrumentation can record prompts and outputs, which would reach the host's exporter outside galaxie's allowlisted spans. Each framework face reports only content-free events through the adapter's trace port.
13. **Parity reference.** The reference is the same graph running natively on CPython. The Python conformance lane compares CPython, Pyodide on Node and Pyodide in Chromium transcripts, as ADR-0016 does for JavaScript.

## Alternatives considered

- **Wasmtime.** Rejected: not a browser runtime, and it needs a native host.
- **componentize-py and jco now.** Deferred: build-time imports only, WASI builds needed for every native extension, and experimental browser support. It remains the candidate for isolated guests.
- **The full `pydantic-ai` package.** Rejected: it installs every provider SDK, which would let agent code call providers directly.
- **Pyodide on the main thread.** Rejected: synchronous Python work would block the page and delay cancellation, budgets and epoch checks.
- **Providers in Python holding a call lease.** Rejected: it duplicates WebLLM, Built-in AI and the OpenAI-compatible client, and puts credentials in a second heap.
- **Policy reimplemented in Python.** Rejected: two implementations of each guarantee would drift, and only one is tested by the existing suite.
- **A separate Python checkpoint store.** Rejected: it would have to reimplement scoping, fencing, retention and export.
- **A Pyodide fork.** Rejected: the gaps are a few packages, not the interpreter.

## Consequences

- The Python adapter is the second adapter that ADR-0017 asks for. Any core change it needs is a finding against the framework-neutral contracts.
- New public contracts: `galaxie.bridge/v1`, the byte-record storage port and the `galaxie` Python API. Each needs versioning and golden tests.
- Pyodide adds a download of several megabytes and seconds of cold start. Each Python worker needs the WASM CSP directives.
- Each Pyodide, LangChain or LangGraph release can add a compiled dependency. Keeping wheels or stand-ins current is ongoing maintenance.
- Durable human-in-the-loop for pydantic-ai is a separate design; until then its runs cannot pause for a user interaction.
- The ADR-0002 bypass is wider for Python, because the JavaScript lint does not apply and the `js` module reaches page APIs from the worker.
- Brief §16.7's entry gate opened on 2026-10-30 with the language-tutor port above. The ADR stays Proposed until that port meets its success criteria.

## Verification

- **Observed, 2026-10-30:** the throwaway [Python bridge spike](../../spikes/python-bridge/README.md) passes on Node 24.15.0 and headless Chromium 156.0.8078.4 on an Apple M5 Pro. Each dedicated Worker runs Pyodide 314.0.7, LangGraph 1.2.18, langchain-core 1.7.3, langgraph-checkpoint 4.3.1 and pydantic-ai-slim 2.63.0. The graph uses `GalaxieChatModel` calling the existing JS deterministic mock over draft `galaxie.bridge/v1`, a capability forwarding its full task namespace, a four-field request read from `aget_state`, resume by interrupt ID, and abort during an outstanding bridged model call. The interrupting node re-executes; the completed model and capability nodes do not. A pydantic-ai `Model` subclass runs one agent with a bridged tool and two mock requests. The fixture maps only its known request phases and does not implement streaming or a general message translator.
- **Measured:** [summary.json](../../spikes/python-bridge/summary.json) records initialization and cold agent-ready times, abort observations, exact runtime file sizes and hashes, and fetched response-body bytes; the [report](../../spikes/python-bridge/README.md#measurements) defines the measurement boundaries. Runtime files occupy 13,531,207 bytes; wheel bodies add about 9.43 MB. Fresh interpreters become ready in roughly six seconds in these single observations, with already installed runtime assets and possibly warm CDN/OS caches. These are demonstrations, not thresholds or compressed network-transfer measurements. A synchronous Python loop cannot acknowledge abort; the host remains responsive and requests worker termination. No durable commit after termination is established.
- **Package gaps:** uuid-utils uses the real hash-pinned upstream 0.19.0 Pyodide wheel; ormsgpack uses a same-name, spike-only 1.13.0 pure-Python stand-in over `msgpack.fallback` 1.1.2. The graph's in-memory checkpoint/interrupt path passes, but general serializer compatibility is unverified. httpx2 2.16.0 and httpx2-jsfetch 1.0 install/import without a stand-in, as do the other pydantic-ai dependencies. The report lists every observed dependency/integration gap and the [dependency probe](../../spikes/python-bridge/dependency-probe.json) records the unmodified installation attempts.
- **Decision after the spike: revise; keep Proposed.** Basic execution is feasible. Decision 7 now states the required executor-aware recovery contract change instead of claiming `RecoveryStore` is unchanged. The contract design was added on 2026-10-30. No package code or security baseline changes were made. The spike uses synthetic read-only host fixtures and an in-memory Python saver, not the core router/broker or durable storage. It does not verify policy enforcement, CPython parity, complete schema rejection, SRI enforcement, credential/span scans, streaming, production cancellation settlement or the opaque byte-record port. The use-case gate has since opened (see Context).
- With the executor-aware session contract: core tests on Node and Chromium cover recording `adapter.id`, a restore under a different executor failing `unsupported` without `pending()` or inbox reconciliation, a start-time mismatch failing `unavailable` and a two-key record from a non-IndexedDB store failing `unrecoverable`. Chromium storage tests cover legacy two-key records read as `langgraph-js` after reopen, insert-if-absent keeping a legacy record, three-key writes and `executorId` in export. Host-local reload and the AT-08, AT-09 and AT-23 tests stay unchanged.
- For the language-tutor port: Python twins of the twelve parity cases pass against the CPython reference on Node and Chromium, the AT-23 credential scan covers the worker and bridge messages, a span scan shows no prompt or output text from framework instrumentation, and the storage fault tests cover the byte-record port.

[S4]: https://pyodide.org/en/stable/usage/packages-in-pyodide.html
