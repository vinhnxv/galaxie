# ADR-0018: Python agents through Pyodide in a worker, with policy kept in JavaScript

- **Status:** Proposed
- **Date:** 2026-10-30
- **Related:** brief §6.2, §7.4, §7.5, §16.2, §16.7; ADR-0002, ADR-0003, ADR-0005, ADR-0006, ADR-0012, ADR-0016, ADR-0017

## Context

Agent authors ask for Python frameworks: LangChain and LangGraph for Python, DSPy, CrewAI and others. Brief §7.4 places Python in the Experimental tier, and §16.7 gates it on a use case strong enough to pay the compatibility cost. This ADR fixes the boundary a Python executor would use, so that a spike can test it and the gate decision can be made with evidence.

Runtimes considered:

- **Wasmtime** is a native WebAssembly runtime for servers and desktops. It does not run in a browser, and running it would need a native host process, which the mission excludes (brief §0.3).
- **Pyodide** is CPython built with Emscripten. Pyodide 314.0.7 ships prebuilt `pydantic_core`, `xxhash`, `orjson`, `tiktoken`, `httpx`, `openai`, `numpy` and `aiohttp` [S4].
- **componentize-py with jco** compiles Python to a WASI 0.2 component and transpiles it to JavaScript. Imports resolve only at build time, every native extension needs a WASI build, and jco calls its browser support experimental.

Required dependencies checked on PyPI against the Pyodide package list on 2026-10-30:

| Framework | Missing from Pyodide | Assessment |
| --- | --- | --- |
| `langchain-core` 1.7.3 | `uuid-utils` (Rust) | One wheel to build or replace |
| `langgraph-checkpoint` 4.3.1 | `ormsgpack` (Rust) | One wheel to build or replace |
| `dspy` 3.4.1 | `litellm` and its dependencies | Needs a stand-in; inference only |
| `crewai` 1.15.33 | `chromadb`, `lancedb`, `tokenizers`, `aiosqlite` and others | Not feasible without a fork |

Every galaxie guarantee is enforced in `@galaxie/core` and the JavaScript providers: routing, consent, labels, budgets, private-string guards, output safety, recovery and storage fencing. ADR-0017 says a second framework gets its own executor adapter and must pass its conformance suite without changes to the core contracts. ADR-0003 keeps the JavaScript executor on the main thread.

## Decision

1. **Runtime.** Python agents run on a pinned Pyodide release. Its files load from the host's CDN or object storage with SRI, under the same rules as other runtime artifacts. Wasmtime is not used. componentize-py and jco stay on the watch list as a path to isolated guests (brief §16.7).
2. **Placement.** Each Python agent instance runs Pyodide in its own dedicated Worker. Core, the broker, the router, providers and host bindings stay on the main thread under ADR-0003. Interpreter startup, imports and Python node code are synchronous and cannot yield cooperatively, so they must not run on the main thread. This is a scoped exception for the Python executor; the JavaScript executor keeps ADR-0003.
3. **Boundary.** A new JavaScript package, `@galaxie/adapter-pyodide`, implements `ExecutorAdapter`. A Python package, imported as `galaxie`, contains proxies only: `galaxie.langchain` (chat model and tools), `galaxie.langgraph` (checkpointer and `request_interaction`) and, later, `galaxie.dspy` (LM). The Python side holds no credential, provider, policy, budget or label logic. Each guarantee keeps its single JavaScript implementation.
4. **Model calls.** `GalaxieChatModel` sends the role, messages and options over the bridge. JavaScript performs the call through the routed model path, including consent, reservation, the credential lease, output safety on every chunk and usage settlement, then returns the checked reply or chunks. Python never receives a credential or unchecked model text.
5. **Bridge.** Worker messages carry plain JSON under a versioned schema, `galaxie.bridge/v1`. Messages and tool calls use a fixed shape close to the OpenAI-compatible chat format. No JavaScript proxy objects pass into Python. Abort signals cross as explicit messages. Errors cross as fixed `GalaxieError` codes and messages with no content. Unknown or malformed messages are rejected on both sides.
6. **Capabilities.** `host.capabilities.call(name, input, config)` forwards to `CapabilityPort.call`. The adapter takes `effectScope` from `langgraph_checkpoint_ns`, as the LangGraph.js adapter does, so recovery write IDs keep the same task-namespace rule (AT-35).
7. **Checkpoints.** `@galaxie/storage-indexeddb` gains an opaque byte-record port with the same app/principal scoping, app-epoch and logout-generation fencing, retention, deletion and export rules as the existing saver. The Python checkpointer stores LangGraph Python's serialized checkpoints and writes through it. Session metadata records the executor ID, so core refuses to restore a session with a different executor. `RecoveryStore` is unchanged.
8. **Interrupts.** `request_interaction(request, config)` wraps LangGraph Python's `interrupt()` with the same four-field request. The adapter's `pending()` reads it through `get_state` over the bridge. The LangGraph.js limits still apply: one interrupt ID per pending state, no parallel interrupts, no static breakpoints.
9. **Trust.** Python agent code is trusted, as JavaScript agent code is (ADR-0002). Python can still import `js` and call `fetch` from the worker. The worker has no DOM, but that is not an isolation boundary. Removing network globals after packages load is a mitigation only. A Python lint aid flags `import js`, `pyodide.http`, `urllib`, `socket` and direct provider SDKs, with the same limits as the ESLint plugin.
10. **Packages.** A Python agent ships its wheels and a hash-locked lockfile, and the generated manifest's SHA-256 inventory covers them. Missing compiled dependencies get either Pyodide wheels built with `pyodide-build` and hosted with pinned hashes, or same-name pure-Python stand-ins. Both are pinned to exact upstream versions. galaxie does not fork Pyodide.
11. **Framework order.** LangGraph Python with LangChain models and tools comes first. DSPy comes second, declaring `interrupts: false` and `checkpoints: false`, with a `litellm` stand-in. CrewAI stays in the Remote tier.
12. **Parity reference.** The reference is the same graph running natively on CPython. The Python conformance lane compares CPython, Pyodide on Node and Pyodide in Chromium transcripts, as ADR-0016 does for JavaScript.

## Alternatives considered

- **Wasmtime.** Rejected: not a browser runtime, and it needs a native host.
- **componentize-py and jco now.** Deferred: build-time imports only, WASI builds needed for every native extension, and experimental browser support. It remains the candidate for isolated guests.
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
- The ADR-0002 bypass is wider for Python, because the JavaScript lint does not apply and the `js` module reaches page APIs from the worker.
- Brief §16.7's entry gate still applies. Work beyond the spike waits for a confirmed use case.

## Verification

- A throwaway spike, kept outside `packages/` (brief §16.2): LangGraph Python in a Pyodide worker with the mock model through the bridge, one capability call, one interrupt and resume, and abort, on Node and headless Chromium. It measures cold start and download bytes and lists every package gap it hits. The result confirms, revises or rejects this ADR.
- If the gate opens: Python twins of the twelve parity cases pass against the CPython reference on Node and Chromium, the AT-23 credential scan covers the worker and bridge messages, and the storage fault tests cover the byte-record port.

[S4]: https://pyodide.org/en/stable/usage/packages-in-pyodide.html
