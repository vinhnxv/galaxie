# ADR-0018: Python agents through Pyodide in a worker, with policy kept in JavaScript

- **Status:** Proposed
- **Date:** 2026-10-30
- **Related:** brief §6.2, §7.4, §7.5, §16.2, §16.7; ADR-0002, ADR-0003, ADR-0005, ADR-0006, ADR-0012, ADR-0016, ADR-0017
- **Revisions:** 2026-10-30: added pydantic-ai as the second framework, ahead of DSPy, and the rule for framework-owned instrumentation.
  2026-10-30: recorded the use case that opened the brief §16.7 gate.
  2026-10-30: designed the executor-aware `RecoverySession` contract in decision 7.
  2026-10-30: worker spike passed the basic LangGraph and pydantic-ai paths on Node and Chromium; retained Proposed status, revised the dependency assessment and identified the executor-aware recovery contract change.
  2026-10-30: recorded the maintained RAG adapter's strict-CSP and routed-service evidence; retained Proposed status and the outstanding tutor and recovery criteria.
  2026-10-31: recorded pydantic-ai deferred interactions and durable conversation snapshots, their three-lane evidence, and the unsupported subgraph semantics in decision 11.
  2026-10-31: added maintained RAG evidence for the third executor, mock-only tool calling, deferred passage review and reload; a mock-only hands-on Chrome check covered review, reload restore, resume and Start over.

  2026-10-31: recorded DSPy 3.4.1 custom engines, checked streaming, deterministic replay and durable journals, plus the fourth RAG executor; automated evidence plus a mock-only hands-on Chrome check.
  2026-11-04: recorded Google ADK Python 2.12.0 as the fifth Python executor option (`adk-python`), with its agent-shape and credential-scan evidence in [ADR-0022](0022-google-adk-python-through-the-pyodide-adapter.md); status stays Proposed.
  2026-11-10: recorded tool-less pydantic-ai NativeOutput with routed schemas and bounded repair, and the prepare-time refusal of provider-specific settings; status stays Proposed.
  2026-11-11: pinned `subgraphs: false` for delegating pydantic-ai agents with tests citing probe S1, and measured delegation and child approval in headless Chromium; status stays Proposed.
  2026-11-11: recorded scripted delegation, helper identity, public nested-run guard and hoisted approval/restore probes; child stream paths remain absent and status stays Proposed.
  2026-11-11: recorded the outcome of the pydantic-ai builtin and native tools spike; status stays Proposed.
  2026-11-11: added the public delegation helper, fail-closed nested-run guard, per-child repair accounting and scripted changed-ID recovery evidence; status stays Proposed.
  2026-11-11: added executor-owned child approval hoisting, required child-call display, reserved-state validation and scripted approve/reject/reload evidence; status stays Proposed.

  2026-11-11: recorded the test-only DSPy paused-session state-binding spike; implementation pending, status stays Proposed.

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
| `pydantic-ai-slim` 2.60.0 | `opentelemetry-api`, `logfire-api`, `griffelib`, `genai-prices`, `pydantic-graph` 2.60.0 | Maintained closure is hash-pinned under the unchanged cutoff and installed offline on Node and Chromium; no provider SDK enters the Worker wheel set |
| `dspy` 3.4.1 | Custom-engine closure, including compiled `regex`, `rpds-py` and `pyyaml` | Hash-pinned offline closure passes CPython, Node Pyodide and Chromium; provider/cache dependencies omitted from the Worker, metadata-only `litellm==1.106.2` stand-in on CPython |
| `google-adk` 2.12.0 | Adds `fastapi`, `starlette`, `authlib`, `joserfc`, `google-auth`, `google-genai`, `opentelemetry-semantic-conventions` and Pyodide's wasm `cryptography`; no required dependency lacks a wheel on the executed path | Hash-pinned 29-wheel closure installed without a resolver; gate recorded in [ADR-0022](0022-google-adk-python-through-the-pyodide-adapter.md) |
| `crewai` 1.15.33 | `chromadb`, `lancedb`, `tokenizers`, `aiosqlite` and others | Not feasible without a fork |

Every galaxie guarantee is enforced in `@galaxie-ai/core` and the JavaScript providers: routing, consent, labels, budgets, private-string guards, output safety, recovery and storage fencing. ADR-0017 says a second framework gets its own executor adapter and must pass its conformance suite without changes to the core contracts. ADR-0003 keeps the JavaScript executor on the main thread.

## Decision

1. **Runtime.** Python agents run on a pinned Pyodide release. Its files load from the host's CDN or object storage with SRI, under the same rules as other runtime artifacts. Wasmtime is not used. componentize-py and jco stay on the watch list as a path to isolated guests (brief §16.7).
2. **Placement.** Each Python agent instance runs Pyodide in its own dedicated Worker. Core, the broker, the router, providers and host bindings stay on the main thread under ADR-0003. Interpreter startup, imports and Python node code are synchronous and cannot yield cooperatively, so they must not run on the main thread. This is a scoped exception for the Python executor; the JavaScript executor keeps ADR-0003.
3. **Boundary.** A new JavaScript package, `@galaxie-ai/adapter-pyodide`, implements `ExecutorAdapter`. A Python package, imported as `galaxie`, contains proxies only: `galaxie.langchain` (chat model and tools), `galaxie.langgraph` (checkpointer and `request_interaction`), `galaxie.pydantic_ai` (model and tools) and `galaxie.dspy` (custom-engine LM, tools and replay interactions). The Python side holds no credential, provider, policy, budget or label logic. Each guarantee keeps its single JavaScript implementation.
4. **Model calls.** `GalaxieChatModel`, the pydantic-ai `GalaxieModel` (a `pydantic_ai.models.Model` implementing `request` and `request_stream`) and the DSPy LM send the role, messages and options over the bridge. JavaScript performs the call through the routed model path, including consent, reservation, the credential lease, output safety on every chunk and usage settlement, then returns the checked reply or chunks. Python never receives a credential or unchecked model text.
5. **Bridge.** Worker messages carry plain JSON under a versioned schema, `galaxie.bridge/v2`. Messages and tool calls use a fixed shape close to the OpenAI-compatible chat format. No JavaScript proxy objects pass into Python. Abort signals cross as explicit messages. Errors cross as fixed `GalaxieError` codes and messages with no content. Unknown or malformed messages are rejected on both sides.
6. **Capabilities.** `host.capabilities.call(name, input, config)` forwards to `CapabilityPort.call`. The adapter takes `effectScope` from `langgraph_checkpoint_ns`, as the LangGraph.js adapter does, so recovery write IDs keep the same task-namespace rule (AT-35).
7. **Checkpoints.** `@galaxie-ai/storage-indexeddb` gains an opaque byte-record port with the same app/principal scoping, app-epoch and logout-generation fencing, retention, deletion and export rules as the existing saver. The Python checkpointer stores LangGraph Python's serialized checkpoints and writes through it. The submission inbox and effect-journal operations need no change. Session identity needs one, because the spike found that `RecoverySession` holds only the agent ID and version and rejects extra fields. Without the executor, a session written by one executor and restored by another with the same agent ID and version would read as fresh, and accepted answers and journalled effects would be reconciled against a different graph. The change, implemented with `@galaxie-ai/adapter-pyodide` and not before:
   - `RecoverySession` becomes `{ agentId, agentVersion, executorId }`, all required non-empty strings. Core writes `executorId` from `ExecutorAdapter.id`, and its validator requires exactly these three keys.
   - The adapter version is not recorded, so an adapter release never strands sessions. An adapter that cannot read its own older checkpoints fails `unsupported` from `pending()`, or takes a new `id` for a permanent format change.
   - Both identity checks compare all three fields. A start-time mismatch keeps failing `unavailable`. A restore-time executor mismatch fails `unsupported` with the fixed message "The saved session uses a different executor.", reports `restore_failed`, and makes no `pending()` call or inbox reconciliation. Errors and diagnostics carry no identifiers.
   - `@galaxie-ai/storage-indexeddb`, which is already the LangGraph.js saver, reads a stored two-key record as `executorId: 'langgraph-js'`, the only executor that existed when it was written. New writes always have three keys. The record envelope stays `v: 1`, with no database version change and no rewrite. Core never names a framework (ADR-0017).
   - Core also supplies a framework-neutral `registerRestoredData(value)` hook on `RunRequest` and the options to `ExecutorAgent.pending`. Adapters can register decoded checkpoint JSON as private before restored interaction validation or live outbound calls. The DSPy adapter registers stored input and journal results and refuses restoration without a required hook. Core contains no framework names; other executors retain their existing behavior.
   - Every other `RecoveryStore` must return three keys; in this repository that is only the in-memory test store. This breaks the port, which is acceptable while all packages are private and unreleased.
   - `galaxie.session-export/1` adds `executorId` to `metadata.agent`. The field is additive and no import exists, so the format name is unchanged.
   - Older code reads a three-key record as `corrupt` and marks the session unrecoverable. A release before 1.0 must therefore ship readers that accept both shapes before any build writes three keys.
8. **Interrupts.** `request_interaction(request, config)` wraps LangGraph Python's `interrupt()` with the same four-field request. The adapter's `pending()` reads it through `get_state` over the bridge. The LangGraph.js limits still apply: one interrupt ID per pending state, no parallel interrupts, no static breakpoints.
9. **Trust.** Python agent code is trusted, as JavaScript agent code is (ADR-0002). Python can still import `js` and call `fetch` from the worker. The worker has no DOM, but that is not an isolation boundary. Removing network globals after packages load is a mitigation only. A Python lint aid flags `import js`, `pyodide.http`, `urllib`, `socket`, direct provider SDKs and provider-prefixed model strings such as `Agent('openai:…')`, with the same limits as the ESLint plugin.
10. **Packages.** A Python agent ships its wheels and a hash-locked lockfile, and the generated manifest's SHA-256 inventory covers them. Missing compiled dependencies get either Pyodide wheels built with `pyodide-build` and hosted with pinned hashes, or same-name pure-Python stand-ins. Both are pinned to exact upstream versions. For DSPy custom engines, the Worker omits the non-imported hard dependencies `litellm`, `openai`, `gepa`, `tenacity`, `diskcache` and `cachetools`. CPython uses a same-name workspace `litellm==1.106.2` member with metadata only and no importable module; accidental provider use fails closed. The existing release cutoff and all existing pins remain fixed. galaxie does not fork Pyodide.
11. **Framework order.** LangGraph Python with LangChain models and tools comes first. pydantic-ai comes second, pinned as `pydantic-ai-slim==2.60.0` with `pydantic-graph==2.60.0`, without provider SDKs in its Worker wheel set. Its tools wrap `host.capabilities.call`, and structured output is validated in Python after JavaScript checks the raw text. Tool-less `NativeOutput` sends the schema as a routed `jsonSchema` constraint without prompt text, with native validation retries charged through `ModelRoute.repairAttempts` and the shared run repair budget. Deferred tool requests end the agent run and become one author-mapped galaxie interaction; resume supplies complete `DeferredToolResults` to a new run. At each pause and completion, pinned `ConversationTypeAdapter` bytes preserve messages, usage, conversation identity and deferred requests through the existing scoped byte-record port. Pause ordinals and effect positions also persist. The port accepts only `langgraph-python | pydantic-ai-python | dspy-python` byte-row tags; exports copy the stored tag. With matching recovery, accepted answers reconcile and succeeded write receipts replay after reload. It declares `streaming`, `interrupts`, `resume` and `checkpoints` true. Without the port, cancellation or Worker loss still discards pending state. Snapshots do not journal every in-flight model call. `subgraphs` remains false: measured child streams have no host child events or paths. `galaxie.pydantic_ai.run_child` shares the parent's usage and limits, derives distinct child identity from message position and key, and resets native repair accounting per child. A public-only guard refuses plain nested model/capability work and nested `Executor.run` before bridge requests. It fails closed when request attribution is missing; it is accident-proofing, while ADR-0012 controls stay in JavaScript. Opt-in `run_child(..., hoist_approvals=True)` carries one child approval through the parent pause, with executor-owned validation and required child-call display; see the delegation verification below. The maintained RAG example offers it for mock tool-calling models, with cited text output and optional passage review through deferred approval metadata. Its scoped byte records, recovery store and fenced ownership restore the pending review after reload; Start over deletes it. The default question flow stays in memory. The built-in browser providers do not declare tool calling, so default mode omits this executor. DSPy comes third, pinned to 3.4.1 with custom-engine `GalaxieLM(role)`, asynchronous module execution and capability-backed tools over bridge v2. It declares `streaming`, `interrupts`, `resume` and `checkpoints` true, and `subgraphs` false: nested modules have no checkpoint namespace, interrupt propagation or stream paths, and a pause unwinds the whole program. `request_interaction` pauses module or tool code; resume re-executes against digests and recorded results of completed model, capability and interaction calls. Author code must be deterministic apart from those calls; divergence fails `unrecoverable` before later live calls. Replayed calls are silent and uncharged. Session-bound journals and counters persist through the byte-record port with recovery, refuse a different DSPy version or journal format, and must fit the 1 MiB bridge bound before a pause publishes. Completion keeps compact counters; work after the last committed pause can repeat after Worker loss, with broker receipts preventing repeated writes when recovery and stable call order apply. DSPy's RAG program retrieves from run input, optionally pauses before any model request, then answers from kept passages with `ChainOfThought`. It requires no model tool calling and is offered whenever the answer role has a configured provider. Real-model format reliability remains unmeasured. CrewAI stays in the Remote tier.
   An `Executor` with `stream_fields` always streams in the Worker and requires a provider declaring streaming. Declared fields must belong to exactly one predictor with a plain `str` output annotation. Streaming ReActV2 requires `next_thought` annotated as `str`; a field header indented on its line is not streamed, though final parsing still supplies its value. JSONAdapter is non-streaming only: the Worker excludes `jiter`. Native provider schema mode is unsupported, and ChatAdapter JSON fallback is disabled to keep call sequences deterministic.

   ReAct turns an ordinary exception from author tool code into an observation containing a five-frame traceback, including file paths and source lines; the next routed model call carries it. Authors must keep sensitive details out of those exceptions. Galaxie failures end the run before another model call and retain fixed codes instead of travelling as observations.

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
- New public contracts: `galaxie.bridge/v2`, the byte-record storage port and the `galaxie` Python API. Each needs versioning and golden tests.
- Pyodide adds a download of several megabytes and seconds of cold start. Each Python worker needs the WASM CSP directives.
- Each Pyodide, LangChain or LangGraph release can add a compiled dependency. Keeping wheels or stand-ins current is ongoing maintenance.
- Durable pydantic-ai interactions require the existing byte-record and recovery ports. Conversation snapshots cover pauses and completion, not arbitrary mid-run continuation; writes outside the broker have no replay guarantee.
- The ADR-0002 bypass is wider for Python, because the JavaScript lint does not apply and the `js` module reaches page APIs from the worker.
- Brief §16.7's entry gate opened on 2026-10-30 with the language-tutor port above. The ADR stays Proposed until that port meets its success criteria.

## Verification

- **Maintained DSPy evidence, 2026-10-31:** the 48 scripted cases in the [DSPy matrix](../../tests/conformance/compatibility-matrix-dspy.json) cover custom-engine calls, tools, checked field streaming, pauses, silent replay and durable restore. The recorder reproduces 38 independent CPython goldens on Node Pyodide and headless Chromium; durable cases add native-driver and JavaScript host restore probes. Separate reload/fault tests cover receipt replay, accepted submissions, private-string registration before restored URL checks and outbound calls, version/format/session refusal, compact completion, exports and storage fencing. [Native RAG tests](../../examples/rag-browser/agent_py/tests/test_dspy_agent.py) and [Node Pyodide tests](../../examples/rag-browser/test/dspy-agent.node.test.ts) prove input-owned retrieval, review before model access to passage text, kept-only citations and checked answer streams. [Chromium page tests](../../examples/rag-browser/test/loop.node.test.ts) cover selected-executor bytes, review reload/resume, Start over deletion, switching all four executors, provider availability without tool calling and the injection canary under unchanged CSP/Trusted Types and request assertions. `dev:mock` serves all four. Existing executors, goldens, matrices and third-party wheel inventories are unchanged. This records automated fixture evidence; a mock-only hands-on Chrome check (2026-10-31) covered a cited answer, review with two kept passages, reload restore of the executor and pending review, resume and Start over. No real model, download or performance measurement is claimed.

- **Google ADK Python evidence, 2026-11-04:** `adk-python` runs scripted `LlmAgent`, `SequentialAgent`, `ParallelAgent`, `LoopAgent` and transfer trees with the results native CPython shows, streams checked deltas, pauses and resumes confirmations and long-running tools (also across reloads), restores durable sessions and passes a credential scan on Node and, for a subset, headless Chromium under the unchanged strict CSP and Trusted Types. `subgraphs` is false; `Workflow`, `AgentTool` and the pause shapes ADK cannot resume faithfully fail `unsupported` at prepare. No real model, device measurement or external developer trial exists ([ADR-0022](0022-google-adk-python-through-the-pyodide-adapter.md), [matrix](../../tests/conformance/compatibility-matrix-adk-python.json)).
- **Maintained pydantic-ai RAG evidence, 2026-10-31:** [CPython agent tests](../../examples/rag-browser/agent_py/tests/test_pydantic_ai_agent.py) and [Node Pyodide tests](../../examples/rag-browser/test/pydantic-ai-agent.node.test.ts) cover retrieval, citations, deferred passage review and fail-closed resume. The agent takes review data from broker-returned tool history, stores trusted passages in `ApprovalRequired` metadata, exposes only private-user-labeled IDs/titles and validates the selected IDs before approving the tool. The final cited answer remains text output, so only checked text deltas reach the display. [Real headless Chromium page tests](../../examples/rag-browser/test/loop.node.test.ts) cover lazy selection, retrieval/citations, joined answer deltas, selected-executor served-byte totals, pending-review reload through reopened scoped IndexedDB, executor restoration, kept-passage resume, Start over deletion, switching all three executors and the injected-passage output block without an added interaction or request. Review instances retain recovery and fenced Web Lock ownership. `dev:mock` builds and serves all three executors; pydantic-ai requires an answer-role provider declaring `tool-calling`, which the bundled WebLLM and Built-in AI descriptors do not. The deterministic mock now scripts nameless prompted-output retries with opt-in assistant-turn sequencing from conversation history, with Node Pyodide retry coverage. The existing LangGraph agents, goldens, compatibility matrices and third-party wheel inventory remain unchanged. Strict CSP, Trusted Types and JavaScript policy controls remain unchanged. A mock-only hands-on Chrome check on 2026-10-31 covered an answer with citation, review, reload restore of the same pending review, resume with one kept passage and Start over; no real-model or device-performance result is claimed.

- **pydantic-ai approvals and durable conversations, 2026-10-31:** the 31 [pydantic-ai conformance cases](../../tests/conformance/compatibility-matrix-pydantic-ai.json) compare native CPython, Node Pyodide and real headless Chromium, including approved/denied and mixed tools, external deferred results, consecutive pauses, invalid and incomplete resume payloads, double submit, stale IDs, and growing/final JavaScript output checks. Eight reload variants serialize native conversations and reconstruct fresh agents; Node recreates runtimes/Workers, and Chromium reloads the page and reopens scoped IndexedDB. Requests, interactions, capabilities, streams and outputs match the existing native goldens; restored interaction IDs remain identical. Node and Chromium also prove accepted-answer reconciliation and Worker loss after an approved write or an unapproved write following resume replay one succeeded receipt without a second binding call. A changed replay input fails `unrecoverable`. Failed completion commits retain the committed pause for same-Worker restore, and completion overwrites orphan interrupt rows before committing; export then reports no pending interaction. Corrupt snapshots fail with fixed content-free errors; executor identity rejects a different saved executor before snapshot reads. Storage tests cover both closed-set byte tags, content-free default export, personal export copying the stored tag, legacy LangGraph rows, principal isolation, retention, logout and app-epoch fencing. The LangGraph driver, goldens, matrices and third-party wheel inventory are unchanged. Strict CSP, Trusted Types and external-request blocking remain unchanged. These are deterministic fixtures; no real model, download, arbitrary mid-run replay or pydantic-ai subgraph support is claimed.

- **Maintained RAG review evidence, 2026-10-30:** opt-in review runs retrieval in a subgraph on both executors, pauses with private-user-labeled IDs/titles, and streams an answer using only kept passages through JavaScript output checks. Node Pyodide and real Chromium share the capability/interaction/model/output transcript with JavaScript. Separate bounded Chromium page tests cover selection, pending-review reload through reopened IndexedDB, executor restoration, resume, Start over deleting checkpoint/recovery records, and returning to the default in-memory flow. The host uses scoped saver recovery, fenced Web Lock ownership and an executor/session reference. The native stand-in serializer checks include review checkpoints and submissions. Strict CSP, Trusted Types and external-request blocking remain unchanged. The documented build-and-preview mock command serves both executors for the Claude reviewer's hands-on check; this run claims no hands-on Chrome or real-model result.

- **Observed, 2026-10-30:** the throwaway [Python bridge spike](../../spikes/python-bridge/README.md) passes on Node 24.15.0 and headless Chromium 156.0.8078.4 on an Apple M5 Pro. Each dedicated Worker runs Pyodide 314.0.7, LangGraph 1.2.18, langchain-core 1.7.3, langgraph-checkpoint 4.3.1 and pydantic-ai-slim 2.63.0. The graph uses `GalaxieChatModel` calling the existing JS deterministic mock over draft `galaxie.bridge/v1`, a capability forwarding its full task namespace, a four-field request read from `aget_state`, resume by interrupt ID, and abort during an outstanding bridged model call. The interrupting node re-executes; the completed model and capability nodes do not. A pydantic-ai `Model` subclass runs one agent with a bridged tool and two mock requests. The fixture maps only its known request phases and does not implement streaming or a general message translator.
- **Measured:** [summary.json](../../spikes/python-bridge/summary.json) records initialization and cold agent-ready times, abort observations, exact runtime file sizes and hashes, and fetched response-body bytes; the [report](../../spikes/python-bridge/README.md#measurements) defines the measurement boundaries. Runtime files occupy 13,531,207 bytes; wheel bodies add about 9.43 MB. Fresh interpreters become ready in roughly six seconds in these single observations, with already installed runtime assets and possibly warm CDN/OS caches. These are demonstrations, not thresholds or compressed network-transfer measurements. A synchronous Python loop cannot acknowledge abort; the host remains responsive and requests worker termination. No durable commit after termination is established.
- **Package gaps:** uuid-utils uses the real hash-pinned upstream 0.19.0 Pyodide wheel; ormsgpack uses a same-name, spike-only 1.13.0 pure-Python stand-in over `msgpack.fallback` 1.1.2. The graph's in-memory checkpoint/interrupt path passes, but general serializer compatibility is unverified. httpx2 2.16.0 and httpx2-jsfetch 1.0 install/import without a stand-in, as do the other pydantic-ai dependencies. The report lists every observed dependency/integration gap and the [dependency probe](../../spikes/python-bridge/dependency-probe.json) records the unmodified installation attempts.
- **Decision after the spike: revise; keep Proposed.** Basic execution is feasible. Decision 7 now states the required executor-aware recovery contract change instead of claiming `RecoveryStore` is unchanged. The contract design was added on 2026-10-30. No package code or security baseline changes were made. The spike uses synthetic read-only host fixtures and an in-memory Python saver, not the core router/broker or durable storage. It does not verify policy enforcement, CPython parity, complete schema rejection, SRI enforcement, credential/span scans, streaming, production cancellation settlement or the opaque byte-record port. The use-case gate has since opened (see Context).
- **Maintained RAG adapter, 2026-10-30:** [adapter-pyodide](../../packages/adapter-pyodide/README.md) reimplements the bridge for the [browser-built RAG example](../../examples/rag-browser/README.md). A dedicated module Worker boots Pyodide 314.0.7, verifies and installs the hash-locked wheel set, evaluates `1 + 1` and imports `langgraph.graph` and `langchain_core.messages` under the unchanged stage 1 CSP/Trusted Types header. The page and Worker report zero policy violations. Before loading Pyodide, the entry replaces `importScripts` with a function throwing `TypeError`; module Workers cannot use that API, and the shim prevents Pyodide's classic-worker probe from reaching a Trusted Types sink. No script policy or CSP exception is added.
- **Routed-service evidence:** real Python model and capability calls pass through JavaScript router leases and the broker. Synthetic tests cover credential isolation, output rejection, undeclared capability denial, malformed bridge messages, cooperative abort, termination of a synchronous busy loop and a fresh Worker after cancellation. Host-loop tests cover lazy Python selection, download disclosure, boot cancellation/failure, executor switching and disposal. Providers and retrieval use deterministic fixtures; these tests establish no real-model quality or inference performance.
- **Maintained parity and dependencies:** one committed RAG transcript matches all five lanes: JavaScript on Node and Chromium, native CPython 3.14, and Pyodide on Node and Chromium. Capability inputs, normalized model messages and final output match for every search mode, empty retrieval and non-ASCII/escaped text. The maintained locks resolve under the unchanged seven-day cutoff (`2026-10-23T17:00:00Z`), with no per-package exceptions: LangGraph 1.2.16, langchain-core 1.7.0, langgraph-checkpoint 4.3.0, langgraph-sdk 0.4.9 and LangSmith 0.14.12. uuid-utils uses the real upstream 0.18.0 WASM wheel. httpx2 and httpx2-jsfetch remain required by this LangSmith closure; the lock includes them. These versions differ from the historical spike above.
- **Maintained local measurements, 2026-10-30:** fresh Workers reached agent-ready in about 2.83 s on Node 24.15.0 and 2.85 s on headless Chromium 156.0.8078.4. Python runtime files total 13,412,130 bytes, wheels 6,049,979 bytes and agent sources 4,204 bytes. The product's additional Python response bodies total 19,486,388 bytes including its 20,075-byte Worker bundle. The Chromium parity harness adds 137 bytes of CSP-reporting instrumentation (19,486,525 bytes observed). Node loads runtime bytes from disk and fetches only 6,054,183 bytes of wheels/sources. Timing covers Worker/interpreter boot, verified wheel installation, imports and graph construction; runtime assets were already installed and OS caches may have been warm. These are single local test-lane observations, not GitHub CI results, reference-device downloads, compressed transfer sizes or latency thresholds. See the [example measurements](../../examples/rag-browser/README.md#local-python-observations) for boundaries.
- **LangGraph Python maintained scope:** all five executor features are enabled through bridge v2: interrupts, resume, checkpoints, streaming and subgraphs. A graph must compile with `galaxie.langgraph.checkpointer()`, which returns `GalaxieCheckpointer` when the host supplies the scoped byte-record port and otherwise a Worker-owned `InMemorySaver`. `request_interaction(request, config)` wraps native interrupts, JavaScript validates committed pending requests, and resume addresses the native interrupt ID. Cancellation or Worker loss discards in-memory state; pending/resume then fails with fixed `unavailable` errors. Durable sessions can read committed state through a fresh Worker and restore with the matching recovery store. Calls support text messages and optional stop strings. Decision 7's durable byte-record port and executor identity have the evidence below. The tutor port and DSPy are not included in that LangGraph scope; pydantic-ai has the separate scope recorded above. Wheel hashes bind downloaded third-party packages; locally built wheels, agent sources and self-hosted runtime files retain the page build's trust. Independently pinned runtime/CDN deployment remains unverified.
- **Stage A interrupt evidence, 2026-10-30:** the twelve Python reference cases and native CPython goldens are recorded independently of JavaScript. The `interrupt-resume`, `interrupt-sequence`, `interrupt-durability-sync` and `interrupt-durability-exit` cases match pending IDs/values and final state/counters on real Node Pyodide and real headless Chromium. The built Chromium harness keeps the existing strict CSP and Trusted Types policy, observes zero policy violations and blocks external requests; unknown case names have a fixed failure. Adapter tests cover parallel/ID-less/static interrupts, JavaScript request validation, repeated resume rejection, v1/unknown-operation/unexpected-notification rejection, oversized pending messages, paused Worker loss and cancellation during a resumed model call. The 500 ms liveness bound and JavaScript-owned model/broker controls remain. Internal `astream` chunks are not emitted as public stream events. This stage used memory only; its tests claim no IndexedDB reopen, reload restore, streaming or Python subgraph execution.
- **Maintained durable checkpoint and identity evidence, 2026-10-30:** core records `adapter.id`, validates three-key session identities and rejects executor mismatches before pending-state or inbox reads. IndexedDB reopens legacy two-key identities as `langgraph-js`, retains their version-1 envelope without rewriting it, writes three-key identities and exports `executorId`. The byte-record port shares checkpoint/write transactions, app/principal keys, epoch/logout fencing, retention and deletion with the JavaScript saver. Chromium storage tests cover opaque-byte reopen, principal isolation, cross-principal takeover, logout, export marker timestamps and interrupt counts, and JavaScript reads skipping Python records. Native serializer checks cover the twelve cases, RAG fixtures and parent-effect fixture; intentional exception-to-`repr` and tuple-to-array decoding is expected, with strict equality otherwise. The three reload cases match native CPython reconstruction references on Node Pyodide and Chromium after a fresh runtime and reopened IndexedDB; accepted answers reconcile. Both lanes prove one broker write across two parent executions around a child interrupt, including reopened storage in Chromium. Node covers checkpoint writes during cancellation settlement. Streaming and general subgraph support were not enabled in that stage. The RAG default flow is unchanged and stays in memory; no hands-on review UI or real-model result is claimed. Host-local and the JavaScript adapter/goldens/matrix are unchanged.
- **Maintained streaming evidence, 2026-10-30:** `linear` and `branching` match native CPython stream projections, mode order, paths and final output on Node Pyodide and real headless Chromium through the existing conformance harness. Stream notifications project interrupts, tuples and messages to bounded JSON; message metadata keeps only node and checkpoint namespace. Non-JSON or oversized chunks fail with fixed `unsupported` errors and omit the rejected content. `GalaxieChatModel._astream` requests a streaming provider through the JavaScript lease; growing text and final text pass output checks before delivery, and terminal usage settles once. Both real lanes prove that a mid-stream block fails `denied`, only the allowed prefix is observed in Python, and streams are absent from replay. They also cancel after the first checked delta and close a public Python model stream early; a successful graph waits for terminal model settlement before another run starts. The framework-neutral event journal now retains only lifecycle events. Chromium reports zero CSP/Trusted Types violations and blocks external requests. Existing interrupt and durable-restore evidence still passes; subgraphs was not enabled in that stage. No RAG review/streamed-answer UI, real-model download, inference measurement or hands-on Chrome check is claimed.
- **Maintained subgraph evidence, 2026-10-30:** all five executor flags are true. All twelve Python conformance cases pass on Node Pyodide and real headless Chromium against the native references, with the generated-message-ID exception and fixed error mappings recorded in the [Python comparison matrix](../../tests/conformance/compatibility-matrix-python.json). Subgraph stream paths, child interrupts and resume match. Fresh runtime/Worker creation and reopened IndexedDB restore `interrupt-subgraph` with the same pending ID/value and `{ callSub: 1, s1: 0, sask: 1 }`. A nested write probe preserves parent call ordinals and the complete child task namespace, yielding three distinct effect IDs and replaying their receipts on resume. Chromium coverage uses one build and separate tests with bounded page loads and timeouts, blocks external requests and preserves strict CSP/Trusted Types. Full Pyodide checkpoint histories, real models, device measurements and a hands-on Chrome review flow remain unverified; the RAG default stays in memory and no review UI is added.
- **Still required for the language-tutor port:** the AT-23 credential scan must cover the Worker and bridge messages, a span scan must show no prompt or output text from framework instrumentation, and storage fault tests must cover the byte-record port. This ADR remains Proposed until its broader success criteria are evidenced.

### pydantic-ai agent delegation spike (2026-11)

`galaxie.pydantic_ai.run_child` and the public-only nested-run guard now ship.
The [delegation probes](../../tests/conformance/README.md#pydantic-ai-agent-delegation-probes)
pin the helper and refusal behavior with scripted replies. Versions:
pydantic-ai-slim 2.60.0, pydantic-graph 2.60.0, CPython 3.14.5, Pyodide 314.0.7,
Node 24.15.0 and pnpm 11.21.0. This ADR remains Proposed. Re-run the probes on
every pydantic-ai bump, including the public message and tool run-ID checks.

| Gap | Outcome | Evidence and limits |
| --- | --- | --- |
| Delegation without child pauses | Supported through `run_child`; plain nested runs refused | The helper shares usage and limits, derives distinct positional child identity and isolates each child's native repair counter. Three new CPython/Node Pyodide conformance cases cover a write after approval reload, shared step budgets and `unsupported` before a plain child reaches the bridge. Exact token, cost and tool-call budget probes include child work. |
| Child pause propagation | Supported through `run_child(..., hoist_approvals=True)` | One child with one pending approval and no external calls pauses the parent. The executor preserves and validates its state and requires the child call in display props. Scripted approve, reject and fresh-Worker restore match independent native references; see the [child approval evidence](../../tests/conformance/README.md#pydantic-ai-child-approval-hoist). |
| Subgraphs flag and stream paths | Refused | Probe S1 is pinned by Python wire-notification tests, the adapter driver empty-path tripwire and Node D1 stream assertions. There are no host child stream events or paths. `run_child` is non-streaming, plain child streams are refused, and `subgraphs` remains false, also measured on prepared delegating adapters in Chromium. |

Child conversation identity hashes a domain tag, parent conversation ID, message
position, part index and helper key. It excludes the provider's tool-call ID.
CPython observes equal helper child identities and scopes when that ID changes at
the same position. On Node Pyodide, a crash after the child write followed by a
scripted changed delegate ID restores the identical child scope and effect ID,
with one write and one journal entry. The ID-sensitive control uses the spike's
ID-derived hash as a registered helper key; it changes scope and effect ID and
writes twice. The control stays registered because plain child runs are now
refused. These probes measure galaxie's sensitivity to a changed ID; whether a
real provider regenerates IDs is unmeasured. Replay still requires deterministic
call order and structure, host confirmations and matching checkpoint/recovery
stores.

`Executor.run` registers its fresh run ID and helper children for that execution.
It revokes those IDs at exit, including in contexts inherited by background tasks.
`GalaxieModel.request`, `request_stream` and `capability_tool` refuse an absent or
unregistered run ID before bridge work; a nested `Executor.run` also fails
`unsupported`. Only public pydantic-ai APIs are used. Direct model/helper use
outside an executor remains available. A non-streamed request is authorized by the
`wrap_model_request` capability of the run that makes it, never by `run_id` stamps in
message history (a prompt-less nested run that inherits the parent's history keeps the
parent's stamp, so stamps cannot authorize). A request made outside such a wrapper
during an executor run fails closed.
Ordinary retries, resume, sequential runs and parallel tools pass. The guard is
accident-proofing, not an isolation boundary: plain non-`GalaxieModel` children and
direct trusted `capabilities.call` can bypass it. The helper itself refuses a
child whose selected model, including a `model=` override, is not a
`GalaxieModel`, and retains the existing native-tool,
instrumentation and model-setting validation. ADR-0012 controls remain enforced
in JavaScript.

Public run and request hooks check the actual selected child model, including
agent overrides and capability model selection or replacement. They also refuse
child streaming enabled by event handlers or capabilities before bridge traffic.

Sequential native-output helper children begin at repair indices `[0, 0]`, even
with no repair allowance; retries within a child still use the host route and
shared run repair limits.

With `hoist_approvals=True`, the executor owns the reserved
`galaxie.child-approval` metadata. It checks the versioned entry, JSON conversation,
128 KiB child-state bound, positional child identity, author key and pending-call
consistency at publication, restore and re-entry. The child must have exactly one
approval and no external calls; duplicate call IDs and nested hoist metadata are
refused. A child pending call ID must differ from every parent
pending ID, so the parent's own call can never stand in for the child's in the display
check. A plain sibling tool's return may follow the pending response without being
replayed; a sibling that returns extra user content (`ToolReturn` with `content`) adds
a part this check does not accept, so that shape fails closed `unsupported` after the
sibling ran, and the run is lost. Validation failures use fixed, content-free `unsupported`,
`unrecoverable` and `invalid` errors at those respective boundaries.

The interaction factory reads `hoisted_child_requests(requests)`. Its props must
contain the child's call ID, name and matching JSON arguments together in one
object; missing or changed display data fails closed. The executor supplies the
validated state on approval even when a custom resume callback drops or replaces
it. Denial returns the native delegate denial without re-entering the child.
Sequential child approvals produce separate interaction IDs. A delegate that is
itself gated first asks for its own approval, then asks for the child's approval.

Several hoisted children in one pause, several child approvals, external child
calls and hoisting from inside a registered child remain refused. A tool body may
use only one hoisting child over its whole execution. A second is refused before
its own request or write; if reached after resume, the first approved child may
already have written. Put the hoisting child first to avoid replaying earlier
children. These limits retain the single-pending-interaction contract while
[ADR-0030](0030-several-engine-pauses-published-one-at-a-time.md) remains Proposed.

Other author metadata remains unvalidated, as the original probe-local hoist
probes demonstrate. Snapshot bytes are not authenticated: a checkpoint-store
writer can forge parent and child state. These checks do not replace the
JavaScript bridge and broker controls in ADR-0012. Parent checkpoints still must
fit the 1 MiB bridge frame after encoding; the child-state cap does not guarantee
that an arbitrarily large parent fits.

The [separate matrix](../../tests/conformance/compatibility-matrix-pydantic-ai-delegation.json)
records the three new goldens. The budget reference independently shares native
usage and maps `UsageLimitExceeded` to `budget_exceeded`; the refusal reference
encodes the adapter limit before recording a child request. Node-only probes
assert receipt replay, exact effect IDs and repair indices. Existing goldens,
matrices, locks and core contracts are unchanged. The probes use Node memory-backed
byte checkpoints and recovery. The six delegation and child-approval cases also
match their existing goldens in headless Chromium, with both real page reloads
reopening scoped IndexedDB and preserving one write overall; the
[Chromium results](../../tests/conformance/README.md#chromium-results) record the
per-case observations. Firefox, WebKit, real providers, arbitrary mid-run
continuation and general nested checkpoint semantics remain unmeasured.
The JavaScript entry size budget covers neither the Python wheel nor the adapter.

### pydantic-ai NativeOutput and model-settings spike (2026-11)

The 2026-11-10 spike has these outcomes at pydantic-ai 2.60.0. This ADR stays Proposed.

| Gap | Outcome | Evidence and reason |
| --- | --- | --- |
| Tool-less `NativeOutput(Model)` | Supported | `native-output`, `native-output-repair`, `native-output-repair-refused`, `stream-native-output`, `native-output-second-repair-refused`, `native-output-repair-budget-exhausted` and `stream-native-output-repair` match native CPython on Node Pyodide and real headless Chromium. Requests carry `jsonSchema`, with no schema prompt; Python returns the validated model. The three additional repair cases leave all 35 earlier goldens and eight reload variants unchanged. |
| Native output beside tools, deferred requests or a string schema template | Refused at prepare | `test_native_output_unprovable_shapes_fail_at_prepare_without_bridge_traffic` covers capability/plain tools, unknown toolsets, deferred requests and templates, including an empty string. No routed provider combines tools and a schema constraint in one call; a template would put the schema into the prompt. The request-time backstop refuses later tools and prompted templates before the bridge. |
| Provider-specific model settings | Refused | `test_agent_model_settings_fail_at_prepare_without_bridge_traffic`, `test_model_owned_settings_are_refused_before_merging_or_stripping` and the existing request-time refusal test cover the boundary. The router selects the provider at call time; an agent cannot know which provider a prefixed setting will reach. `ModelPort` has no per-call settings channel, and request shaping, credentials and output limits stay host-owned under ADR-0006 and ADR-0012. |

Agent-level callable settings and mappings with any key other than `stop_sequences`
fail `unsupported` at prepare. Capability-, model- and run-contributed settings are
checked before the bridge; model-owned settings are checked before pydantic-ai
merges or strips them. `NativeOutput(template=False)` remains allowed. Unknown or
non-empty toolsets beside native output fail closed. Plain `output_type=Model`
keeps tool mode; `PromptedOutput` keeps its existing prompt behavior.

| Setting | Decision |
| --- | --- |
| `stop_sequences` | Pass through as bridge `stop`, including for native output. |
| `max_tokens` | Host configuration: `ModelRoute.maxTokens` supplies the provider's lease limit and reservation. No agent-level override. |
| `temperature`, `top_p`, `top_k`, `seed`, `presence_penalty`, `frequency_penalty` | Host provider configuration where exposed, for example `WebLLMChatModelOptions.temperature`; refused as agent settings. |
| Provider-prefixed keys (`openai_*`, `anthropic_*`, `google_*`, and others) | Refused: provider selection belongs to the host. |
| `extra_headers`, `extra_body`, `timeout`, `service_tier`, `cache`, `logit_bias` | Refused: outbound request shaping remains host-owned and has no routed per-call channel. |
| `parallel_tool_calls`, `tool_choice`, `thinking`, `max_retries`, `request_timeout`, and every other non-`stop_sequences` key | Refused before the bridge, at prepare when visible on the agent. |

`GalaxieModel` maps only the native output object's schema to `jsonSchema`; its
`name`, `description` and `strict` are not forwarded. The adapter requires
`structured-output`, plus `streaming` for streamed requests, and checks growing and
final text in JavaScript before Python validates it. Each native request after the
first in a run carries its request count as a one-based `repairAttempt`. The count
comes from the run, not from the message history, so a history processor cannot hide
or invent attempts. Native mode has no tools or resumed pauses, so every later request
retries a reply that failed schema validation or an output validator: a `ModelRetry`
from an output validator is charged like a schema failure and, with the default
`repairAttempts` of `0`, fails `invalid`.

The bridge requires a positive safe integer beside `jsonSchema`. The adapter
forwards it to `ModelPort.begin`, which rejects an index above the route's
`repairAttempts` (default `0`) with fixed `invalid` before provider dispatch, or
claims the shared run repair budget (default `2`); exhaustion fails
`budget_exceeded`. Each permitted retry takes the ordinary routing, consent,
labels, credential lease, token/cost reservation, output checks and settlement
path. Python must also permit the output retry. Tool-output and `PromptedOutput`
retries remain ordinary calls bounded by Python's step limit and the run's token,
cost and wall-clock budgets; they do not claim structured-output repairs.

Repair accounting is cooperative: trusted Python supplies the index (ADR-0002).
JavaScript enforces its bounds and the token, cost and wall-clock budgets on each
call; Python enforces the pydantic-ai step limit with `UsageLimits(request_limit=steps)`.
Pydantic-ai's retry feedback includes validation detail and rejected values sent
only to the routed model, unlike the LangGraph wrapper's fixed repair text. It
does not enter galaxie's fixed errors or allowlisted telemetry.

Each provider below needs the host's `structured-output` declaration. These are
the existing provider mechanisms, not live endpoint or real-model evidence for
this pydantic-ai path.

| Routed provider | Constraint and limits | Evidence |
| --- | --- | --- |
| OpenAI-compatible | `response_format: json_schema`, always `strict: true`, tool-less. OpenAI strict mode requires `additionalProperties: false` and every field required: use `model_config = ConfigDict(extra='forbid')` and no defaulted fields on output models routed there. | Mock/loopback provider tests only; no live endpoint tested. |
| ONNX / Transformers.js | Optional constrained-decoding package, tool-less; rejects schemas using `pattern` or `format`. | Fake runtime tests only; no real-model native-output run. |
| WebLLM | `response_format` with the JSON Schema; no tool-calling declaration. | Existing fake-provider tests; no real-model run for this pydantic-ai mapping. |
| Built-in AI | `responseConstraint` with `omitResponseConstraintInput: true`; no tool-calling declaration. | Existing fake Prompt API tests; no device run for this mapping. |
| Mock | Accepts but ignores `jsonSchema`; test-only. | Native parity cases use scripted replies; repair cases opt into assistant-turn sequencing. |

The [matrix](../../tests/conformance/compatibility-matrix-pydantic-ai.json)
records the schema normalization. The native reference derives the repair index
from its own history and checks the route limit before charging the run repair
budget. Both Pyodide lanes exercise the real router with per-case route and budget
settings in `fixtures.json`. The reference does not receive the face's index, so
parity proves the counter only at the exercised boundaries; Node bridge-frame
assertions and Python unit tests prove the exact values. The streamed repair case
emits the rejected attempt's checked text before validation fails. The mock ignores
the schema. Python face/bridge and JavaScript adapter tests also cover refusals
before dispatch and preservation of the ordinary model path. Existing goldens,
other executors, core contracts and dependency locks are unchanged. No real-model
constraint reliability or device performance is claimed.

### pydantic-ai builtin and native tools spike (2026-11)

The [native-tool refusal probes](../../tests/conformance/README.md#pydantic-ai-native-tool-refusal-probes)
apply a rule committed before measurement to pydantic-ai-slim and pydantic-graph
2.60.0, CPython 3.14.5 and Node Pyodide 314.0.7. All evidence is scripted or mock.

| Gap | Outcome | Evidence and reason |
| --- | --- | --- |
| Static retrieval kinds: `web_search`, `web_fetch`, `x_search`, `file_search`, `mcp_server` | Refused | N1/N2/N3 refuse native declarations before bridge work. N4 proves equal ordinary/local capability traffic, but two model requests fail its fixed one-request criterion, so it does not award alternative. |
| Static `advisor`, `code_execution`, `image_generation`, `memory`, `tool_search` | Refused | N1/N2 show prepare/request refusal; provider execution or state has no broker path. Required tool search first conflicts with the upstream automatic declaration; a public capability mutation exposes it to prepare validation. |
| Dynamic and per-run native tools | Refused | D1 refuses factories at prepare without invoking them; D2/D3 refuse overrides and direct optional requests before transport. D4 observes no per-run capabilities option from the executor. |
| Native response parts | Refused | RP1 rejects history with `unsupported`; RP2 and B1/B2 reject closed-shape violations with `invalid`; RP3 rejects array provider content with `unsupported` before Python receives a reply. |

Support requires four conditions, none established here: S1, a repository provider
executing native tools (the OpenAI-compatible mapper accepts function declarations
and string replies only; WebLLM, Built-in AI and Transformers have no native-tool
execution); S2, bridge declaration/result channels (B1/B2 reject both); S3, a router
feature for the kind (the four `ModelFeature` labels contain none); S4, measured
provider-side execution through broker grants, labels, budgets and confirmations
(no such execution occurred). The evidence README cites the owning source paths.

Characterization first pinned acceptance at prepare and refusal at the first
request. The new validation beside `_validate_agent` now refuses static native
tools and callable factories with fixed `unsupported` before transport. Even a
factory returning `None` is refused without execution. Only optional `tool_search`
is ignored at prepare, because pydantic-ai injects it into ordinary agents;
deferred-loading tools still activate the request-time refusal. Revalidating an
executor checks capabilities added after its construction. The existing request,
history, reply, bridge and adapter checks stay unchanged.

For retrieval, authors can declare `capability_tool(name, capability, schema)`
bound by the host to a broker capability, or use
`WebSearch(native=False, local=<capability_tool>)`. The measured search replacement
has identical requests, one capability call and positional effect scopes. Returned
data keeps the broker's labels; grants, destination policy, budgets and host write
confirmation still apply. This documents a working retrieval form, not provider
tool parity or an alternative outcome under the fixed rule. Generic code execution
is forbidden by ADR-0012 A.3; image results lack a bridge channel, while memory and
advisor tools keep state or invoke models outside the router. No replacement for
those native tools ships here.

`MCP` defaults to `native=False` in 2.60.0; the measured native form explicitly
sets `native=True, local=False` with inert server arguments. Its local fallback
requires the absent optional `fastmcp` package. `MCP(local=True)` and
`WebSearch(local='duckduckgo')` could open Worker network access and were not run.
Native-tool Chromium probes, real providers, actual native execution and network
reachability remain unmeasured. A host-registered model that runs tools internally
and returns only a string is undetectable by this adapter; the host takes on those
controls under ADR-0012's SDK-controlled-path limit. That limit is reasoned, not
measured. Existing goldens, matrices, locks, decision 11 and JavaScript package
source are unchanged. This ADR stays Proposed.

[S4]: https://pyodide.org/en/stable/usage/packages-in-pyodide.html

### DSPy paused-session state binding spike (2026-11)

On 2026-11-11 the recorded outcome is **supported**: design proven, implementation
pending. The state-only candidate passed every required criterion on DSPy 3.4.1,
CPython 3.14.5, Node 24.15.0 with Pyodide 314.0.7 and Playwright 1.64.1
Chromium 156.0.8078.4 reload through IndexedDB. The [evidence table](../../tests/conformance/README.md#dspy-paused-session-state-binding-spike)
records predictions, observations and commands. `bind-early-inert`,
`bind-late-prompt`, `bind-late-inert`, `bind-early-prompt` and native-only
`bind-fingerprint-inert` decided detection: restore refused before model/capability
requests or replay, stored records were unchanged, and original bytes resumed.
Same-byte cases completed with one replay notification and unchanged counters.
No prediction diverged. Existing #203 author-recipe cases remain unchanged and pass.

The test-only patch adds one optional 64-hex metadata key (82 bytes), on paused
records only, with no checkpoint/journal change. New code accepts old unbound
records; old code refuses bound records without writing. No core contract change
was needed: the driver and adapter already transport opaque metadata. A shipped
implementation must settle optional-key versus version-bump handling under decision
7; this record changes no Decision text. Completed sessions still accept new runs
under changed state, and programs without JSON have byte-identical metadata.

The candidate freezes a sorted manifest of descriptor JSON paths and byte digests
at boot. A Python comment edit changed the all-files digest and left the
JSON-only digest unchanged. Both detect JSON whitespace, renaming and additions and ignore
`__pycache__` and directory enumeration order. This includes unused JSON, and does
not solve Python-source drift. A Node BOM probe binds Python-visible decoded bytes,
which differ from served bytes. A native global `BaseModule.load` wrapper matched
the single-file manifest but missed `load_state(dict)`; the original method was
restored. Descriptor enumeration avoids that global DSPy-version-specific hook.

This is a consistency check against accidental swaps, not integrity protection;
checkpoint metadata is unauthenticated. Firefox, WebKit, real models, other DSPy
versions, concurrent tabs, legacy sessions that pause again, forged metadata and
large many-file descriptors remain unmeasured. Shipped code, existing goldens,
matrices, locks and recorders are unchanged, and authors still need the fingerprint
recipe. The implementation follow-up draft is **Bind paused DSPy sessions to the
loaded offline state files automatically**, parent `galaxie-fv4.3`, for the
orchestrator to file. No Beads issue was created or edited. Status stays Proposed.
