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

  2026-11-11: recorded the DSPy state-binding spike and shipped its optional paused-record metadata key; status stays Proposed.
  2026-11-11: recorded alternative outcomes for DSPy Parallel and threaded Evaluate, with a test-only branch journal design; status stays Proposed.
  2026-11-11: recorded DSPy sync entry point refusal, offline alternatives for model-calling runtime optimizers and measured runtime LabeledFewShot support; status stays Proposed.

  2026-11-11: recorded provider-string LM, schema-output and service-retrieval alternatives and embedding refusal; status stays Proposed.
  2026-11-12: shipped fixed `unsupported` refusal for DSPy thread-pool fan-out; status stays Proposed.
  2026-11-13: refused shipping the DSPy async branch helper after measuring its conflict with persistent divergence markers; no production source or checkpoint format change, status stays Proposed.
  2026-11-13: shipped the DSPy keyed async branch helper with optional journal markers, native/Node replay and Chromium reload evidence; status stays Proposed.
  2026-11-13: accepted the existing DSPy runtime divergence poison checkpoint and revised the gate for a separately scoped helper retry, with sequential and branch persistence pins; status stays Proposed.

  2026-11-12: the LangGraph Python tool-call replies spike registered its outcome rule before measurement; subsequent evidence records five text-protocol alternatives and neighbouring-shape refusal, with no production source shipped.

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
11. **Framework order.** LangGraph Python with LangChain models and tools comes first. pydantic-ai comes second, pinned as `pydantic-ai-slim==2.60.0` with `pydantic-graph==2.60.0`, without provider SDKs in its Worker wheel set. Its tools wrap `host.capabilities.call`, and structured output is validated in Python after JavaScript checks the raw text. Tool-less `NativeOutput` sends the schema as a routed `jsonSchema` constraint without prompt text, with native validation retries charged through `ModelRoute.repairAttempts` and the shared run repair budget. Deferred tool requests end the agent run and become one author-mapped galaxie interaction; resume supplies complete `DeferredToolResults` to a new run. At each pause and completion, pinned `ConversationTypeAdapter` bytes preserve messages, usage, conversation identity and deferred requests through the existing scoped byte-record port. Pause ordinals and effect positions also persist. The port accepts only `langgraph-python | pydantic-ai-python | dspy-python` byte-row tags; exports copy the stored tag. With matching recovery, accepted answers reconcile and succeeded write receipts replay after reload. It declares `streaming`, `interrupts`, `resume` and `checkpoints` true. Without the port, cancellation or Worker loss still discards pending state. Snapshots do not journal every in-flight model call. `subgraphs` remains false: measured child streams have no host child events or paths. `galaxie.pydantic_ai.run_child` shares the parent's usage and limits, derives distinct child identity from message position and key, and resets native repair accounting per child. A public-only guard refuses plain nested model/capability work and nested `Executor.run` before bridge requests. It fails closed when request attribution is missing; it is accident-proofing, while ADR-0012 controls stay in JavaScript. Opt-in `run_child(..., hoist_approvals=True)` carries one child approval through the parent pause, with executor-owned validation and required child-call display; see the delegation verification below. The maintained RAG example offers it for mock tool-calling models, with cited text output and optional passage review through deferred approval metadata. Its scoped byte records, recovery store and fenced ownership restore the pending review after reload; Start over deletes it. The default question flow stays in memory. The built-in browser providers do not declare tool calling, so default mode omits this executor. DSPy comes third, pinned to 3.4.1 with custom-engine `GalaxieLM(role)`, asynchronous module execution and capability-backed tools over bridge v2. It declares `streaming`, `interrupts`, `resume` and `checkpoints` true, and `subgraphs` false: nested modules have no checkpoint namespace, interrupt propagation or stream paths, and a pause unwinds the whole program. `request_interaction` pauses module or tool code; resume re-executes against digests and recorded results of completed model, capability and interaction calls. Author code must be deterministic apart from those calls; divergence fails `unrecoverable` before later live calls. Replayed calls are silent and uncharged. Session-bound journals and counters persist through the byte-record port with recovery, refuse a different DSPy version or journal format, and must fit the 1 MiB bridge bound before a pause publishes. Completion keeps compact counters; work after the last committed pause can repeat after Worker loss, with broker receipts preventing repeated writes when recovery and stable call order apply. DSPy's RAG program retrieves from run input, optionally pauses before any model request, then answers from kept passages with `ChainOfThought`. It requires no model tool calling and is offered whenever the answer role has a configured provider. Real-model format reliability remains unmeasured. Durable DSPy pauses also bind descriptor JSON at boot; see the shipped state-binding decision below. CrewAI stays in the Remote tier.
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

On 2026-11-11 the recorded outcome is **supported**; the design is now shipped
as described below. The state-only candidate passed every required criterion on DSPy 3.4.1,
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
was needed: the driver and adapter already transport opaque metadata. The shipped subsection below settles optional-key handling under decision 7. Completed sessions still accept new runs
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
large many-file descriptors remained unmeasured by the spike. Its candidate stays
uninstalled, used only for native digest and `Module.load` scope comparisons.
Existing goldens, matrices, locks and recorders remain unchanged. Status stays Proposed.

### DSPy paused-session state binding (2026-11, shipped)

Durable DSPy Workers compute a JSON-only descriptor binding before importing the
author's entry and pass it explicitly to `prepare_executor`. The SHA-256 covers
canonical JSON pairs of POSIX relative path and SHA-256 of Python-visible bytes,
sorted by path, excluding `__pycache__`. No JSON means no binding. BOM stripping
binds decoded Worker bytes. Direct executor users stay unbound unless they supply
a digest, and non-durable Workers do not scan the descriptor. Preparation rejects
non-None digests that are not lowercase 64-hex strings with `unsupported` before
they can produce an unreadable paused record.

The metadata version remains `v: 1`, with the existing journal and checkpoint type
tags. Only paused records gain the optional `stateBinding` key. Its fixed lowercase
64-hex digest adds exactly 82 JSON bytes, about 110 base64 characters. The previous
exact key-set check already refuses such records without writing; a version bump
would add no rollback benefit and would require another legacy version path.
Rolling the library back therefore leaves bound pauses unreadable until newer
code returns. New code accepts records without the key.

Restore accepts exactly the original key set or that set plus `stateBinding`.
A present key requires paused status, a lowercase 64-hex string and an equal frozen
executor digest, before registering the session. Unknown keys, malformed values,
a key on another status or a missing live manifest fail with the fixed
`unrecoverable` error. No live calls, replay or writes follow a refused restore;
the original bytes can resume later. Completed and unrecoverable snapshots never
carry the key. Input, journal and interaction props cannot accidentally insert
metadata keys.

The existing pause-size check counts the extra bytes, reducing headroom by about
110 bytes near the 1 MiB bridge limit. An unreadable JSON file fails durable boot
with `unsupported` rather than binding a partial manifest. No additional count or
byte cap is imposed. Any descriptor JSON edit, including unused data or whitespace,
refuses earlier bound pauses. Python sources stay outside the manifest; the author
fingerprint recipe covers them and other files.

This is a consistency check against accidental swaps, not integrity protection:
metadata is unauthenticated. The shipped native, Node Pyodide and Chromium reload
probes retain the spike's refusal, unchanged-row, rollback and legacy outcomes.
Native CPython also measures a legacy session gaining the binding at its next
pause. Firefox, WebKit, real models, other DSPy versions, concurrent tabs, forged
metadata, large many-file descriptors and legacy sessions that pause again outside
native CPython remain unmeasured. ADR-0012 guarantees are unchanged; this ADR stays
Proposed. See the [shipped evidence](../../tests/conformance/README.md#dspy-paused-session-state-binding-spike).

### DSPy parallel and threaded Evaluate spike (2026-11)

The recorded outcome is **alternative** for `dspy.Parallel` and **alternative**
for threaded `Evaluate`, with the replacement proven as a design only. Shipped
author guidance is a sequential loop of `await module.acall(...)`. The
[evidence table](../../tests/conformance/README.md#dspy-parallel-and-threaded-evaluate-spike)
records fixed predictions, observations and the outcome rule on DSPy 3.4.1,
CPython 3.14.5, Node 24.15.0 and Pyodide 314.0.7 with scripted models.

`par-verbatim-parallel-threads` returns three `None` entries natively;
`par-verbatim-evaluate-threads` returns score 0.0 and empty predictions, both with
zero bridge work. Both end `executor_error` in the Worker. Their sequential
variants end `unsupported` in both lanes. `par-verbatim-thread-start` observes
`RuntimeError` for both thread start and pool submission in the Worker. Its single
thread permits asyncio concurrency and concurrent bridge requests; synchronous
model entry points cannot await the bridge.

Contrary to prediction, native single-call gather replay failed:
`par-fan-two-stage-single` and `par-fan-eval-loop` ended `unrecoverable` without
live dispatch. DSPy suspends in `asyncio.to_thread` before journal entry, so task
creation order is insufficient. Both replay in the measured Node cases.
Multi-call re-dispatch can repeat a write before reporting `unrecoverable`.
The branch-keyed candidate passes the measured parity, replay, receipt reuse and
divergence-before-dispatch checks. Pauses inside branches leave no candidate task;
shipped code leaves one sibling until cleanup. Refusals use existing fixed codes.

The candidate adds one optional `branch` string per model/capability journal entry,
bounded to 70 characters, with a group width cap of 32. Root-only checkpoint and
metadata bytes are unchanged. New code accepts old records; unmodified code
refuses branch records with `unrecoverable` and leaves stored rows unchanged.
The format finding is unresolved for shipping: the follow-up must decide an optional
key under `v: 1` versus a version bump under decision 7. No core contract change was
needed: checkpoint bytes and effect scopes remain opaque to core. This spike
changes no shipped source; the conditional prepare-time refusal did not fire.

Author code must be deterministic apart from journaled calls. Chromium, Firefox,
WebKit, real models and other DSPy versions remain unmeasured here. Successful
streaming fan-out, nested groups, pauses inside branches and ReAct branches are
not established; the candidate only measures fixed refusals for the first three.
ADR-0012 controls are unchanged and this ADR remains Proposed.

### DSPy async branch-helper shipping refusal (2026-11)

The later [shipped helper](#dspy-async-branch-helper-2026-11-shipped) meets the revised gate; this subsection records the earlier attempt.

The 2026-11-13 shipping attempt is **refused**. The native keyed-helper experiment
replayed with deterministic scopes across thread hops and reversed arrivals,
but failed the required unchanged-row check on divergence. The driver deliberately
appends a compact unrecoverable checkpoint after a runtime replay mismatch,
preventing retry of the divergent program. The paused row is unchanged; its
replacement as the latest revision is observable storage mutation.

The [retained native and Node Pyodide tests](../../tests/conformance/README.md#async-branch-helper-shipping-refusal)
exercise the existing test-only branch journal and assert the poison marker,
unchanged prior rows and zero further model or capability requests. Unknown-key
rejection during restore remains a different path: it occurs before registration
and changes no rows. Suppressing runtime poison persistence would change the
recovery rule, so the helper was withdrawn instead. No optional `fanout` entry
key or metadata change ships under decision 7; `v: 1` keeps its existing meaning.

Sequential `await module.acall(...)` loops remain the supported alternative.
Code outside journaled calls must be deterministic. New Chromium fan-out probes,
Firefox, WebKit, real models and other DSPy versions remain unmeasured. Checkpoint
validation establishes consistency, not integrity: metadata is unauthenticated.
ADR-0012 controls and Decision text are unchanged; this ADR remains Proposed.

### DSPy divergence persistence decision (2026-11)

On 2026-11-13, the divergence-persistence outcome is **accepted**: keep the
existing compact poison checkpoint and change the acceptance gate for any later
async branch helper. This decision ships tests and documentation only; the
helper remains unshipped. The [retained evidence](../../tests/conformance/README.md#divergence-persistence-decision)
pins the same recovery rule for sequential and test-only keyed programs.

The poison marker prevents later retries of a program that has diverged from
its recorded journal. The earlier unkeyed multi-call crash probe repeated
`alpha` under a new scope before `unrecoverable` propagated; leaving that stored
session resumable would permit repeated side effects on later retries. An
unchanged-row requirement adds no protection beyond the marker. It buys only
availability: rolling back the program could resume the old pause. Sequential
programs already lose that rollback resumability after runtime divergence.

The [driver](../../packages/adapter-pyodide/src/dspy-driver.ts) separates two paths.
An unknown journal key, malformed record, metadata mismatch or state-binding
mismatch is refused during restore before session registration, writing no row.
At runtime, `_Run.begin` or `_Run.frontier` detects replay mismatch before further
dispatch; `Executor.run` marks the session unrecoverable and clears its pending
interaction, journal and input value. The registered driver saves a new compact
`unrecoverable` checkpoint, parented to the previous latest revision. Even the
original unchanged program then restores as `unrecoverable` without requests.

The revised helper gate requires zero further model or capability requests,
byte-identical earlier rows and writes, exactly one compact `unrecoverable`
checkpoint appended by the divergent execution, and later restores remaining
`unrecoverable` without another row. Restore-time refusals must still leave all
rows unchanged. The marker has null input, an empty journal, compact metadata
and one null `__interrupt__` write. A helper retry needs its own plan and must
settle optional-key versus version-bump handling under decision 7.

Changing the driver rule for branch divergence is rejected: it needs production
source and new session state to distinguish branches, leaves divergence
retryable, and gives branches rollback recovery that sequential programs lack.
The cost of retaining the marker is explicit: a divergent session cannot resume,
even after rollback, and the user must start over. Repeated execute calls on an
already poisoned session are characterized separately; their marker count is
not part of this gate.

Evidence uses scripted models in native CPython and Node Pyodide on DSPy 3.4.1,
CPython 3.14.5, Node 24.15.0 and Pyodide 314.0.7. The new sequential pin is
native-only; both lanes execute the same driver string. Chromium, Firefox,
WebKit, real models and other DSPy versions remain unmeasured for this decision.
Checkpoint validation shows consistency, not integrity; metadata is
unauthenticated. No production source, checkpoint format, metadata key, error
code or public symbol changes. ADR-0012 controls and Decision text are unchanged;
this ADR remains Proposed.

### DSPy async branch helper (2026-11, shipped)

On 2026-11-13, `galaxie.dspy.branches({key: async_callable})` ships for keyed
concurrent `module.acall` work. It returns a dict in input order. Keys match
`[A-Za-z0-9_.-]{1,64}`; groups contain at most 32 branches and a run at most
1000 non-empty groups. Empty groups journal nothing. Each branch must await its
journaled calls sequentially, and code outside journaled calls must be deterministic.
Thread-pool `Parallel`, `Evaluate` and `ParallelExecutor` remain refused.

A model or capability journal entry inside a branch gains an optional `fanout`
marker, `<group>/<key>/<call>`. Group ordinals follow program order; call ordinals
are local to the branch, including across DSPy's thread hops. Capability scopes
are `dspy/{conversation}/{run.ordinal}/{group}/{key}/{call}` and leave root
counters alone. The join sorts its journal slice by input key order and local
call ordinal, including on failure. Ordinary author exceptions wait for siblings
and raise the first exception in input order; recorded failures and outer
cancellation cancel and drain siblings.

Metadata remains `v: 1`. Decision 7's reader-first migration rule concerns the
`RecoverySession` envelope; these bytes are the executor's opaque journal.
The old reader already rejects the unknown entry key before registration with
`unrecoverable` and no row, so a version bump adds no rollback safety and would
require a second legacy path. New code restores old records unchanged; programs
without fan-out retain identical checkpoint and metadata bytes. Rolling the
library back makes a fan-out pause unreadable until newer code returns.
Completed non-compact snapshots validate markers too; compact snapshots carry
no journal. Unknown keys, malformed markers, duplicate markers, broken group
order, non-contiguous call ordinals and over-wide recorded groups fail restore
before registration, with no write.

Pause inside a branch, nested groups, streaming with branches, malformed keys
and exceeded bounds end fixed `unsupported`, even if author code catches the
exception. Root journaled calls during a group and overlapping journaled calls in
one branch are refused only when the overlap is observed in flight (`busy` guard);
an overlap that is not observed records calls in arrival order, so a later resume
with different timing can end `unrecoverable` (measured by the review of this
change). A task-identity guard is a recorded follow-up. Persisted groups therefore contain completed calls only. A replayed
group precedes the recorded root frontier, so a missing branch-call marker is
`unrecoverable` before dispatch, regardless of arrival order. Removing or renaming
a recorded key, changing a request, adding a journaled call or ending a branch
early also diverges. An added silent branch is allowed.

The helper meets the accepted divergence-persistence gate: zero further model
or capability requests, byte-identical earlier rows and writes, exactly one
compact poison checkpoint, and later restores refused without another row.
The driver and JavaScript contracts are unchanged. A divergent session cannot
resume even after rollback; the user starts over. Restore-time refusals still
add no row. This establishes consistency, not integrity: metadata and checkpoint
bytes are unauthenticated, and ADR-0012 controls remain in JavaScript.

The [shipped evidence](../../tests/conformance/README.md#shipped-async-branch-helper)
uses scripted models on DSPy 3.4.1: CPython and Node Pyodide cover arrival order,
replay, write receipts and divergence; headless Chromium matches three new live
goldens and reopens IndexedDB in a fresh page and Worker to replay a joined group
without redispatch. State-binding reload tests also pass. Chromium divergence
reload, Firefox, WebKit, real models, other DSPy versions and ReAct branches
remain unmeasured. No existing golden, fixture entry, matrix entry or lock changes.
This ADR stays Proposed.

### DSPy thread-pool fan-out refusal (2026-11, shipped)

Threaded `dspy.Parallel` and `dspy.Evaluate`, including their default thread
count, now end with the existing fixed `unsupported` code and message in native
CPython and Node Pyodide, with zero model or capability requests. This supersedes
the preceding spike's verbatim threaded results; it does not enable fan-out.

The existing DSPy context carries a private settings key with a weak reference to
the run. DSPy's pool propagates that settings context to workers. An LM entry
that lost the run ContextVar but retains the reference records a terminal refusal
and raises a `BaseException` that bypasses DSPy's item-error handler. The run
state preserves refusal even if author code catches that exception. Async engine
completion and streaming use the same guard before any bridge request. The weak
reference does not keep a run alive in stale worker settings.

In the Worker's error path, a `RuntimeError` with a traceback frame whose code is
`threading.Thread.start.__code__` becomes `unsupported`. No exception-message
matching or global thread patch is used. Any such thread-start misuse is classified
the same way. Supported tasks keep their ContextVar and follow the existing path;
no journal format, metadata field, error text, public symbol or core contract
changes. ADR-0012 controls remain in JavaScript and are unchanged.

Raw author-created threads without DSPy's settings remain unattributed natively;
a thread-start error caught by author code is invisible to the executor. DSPy's
own logger is unchanged: the threaded refusal produced no per-item records in the
measured native probe, while sequential refusal and an `n > 1` async call from a
worker thread can still log item text. Items already queued in a native pool may
keep running author callables after the run ended; their LM calls stay refused. An
author's own `await asyncio.to_thread(...)` that fails to start a thread in the
Worker is also reported as `unsupported`, and an error re-raised or wrapped
without the `Thread.start` frame still ends `executor_error`.
Chromium, Firefox, WebKit, real models and other DSPy versions are unmeasured.
Use sequential `await module.acall(...)` loops; the branch journal remains a
separate follow-up. See the [tests and limits](../../tests/conformance/README.md#dspy-thread-pool-fan-out-refusal).
This ADR remains Proposed.

### DSPy sync entry points and runtime optimizers spike (2026-11)

The [runtime probes](../../tests/conformance/README.md#dspy-sync-entry-points-and-runtime-optimizers-spike)
apply a rule committed before measurement on DSPy 3.4.1, CPython 3.14.5,
Node 24.15.0 and Pyodide 314.0.7. Sync entry points are **refused**:
`rt-sync-forward-only` refuses at prepare, and the other five sync shapes end
`unsupported` without requests, including swallowed failures and `to_thread`.
The async `acall` control completes with one request in both required lanes.

Model-calling runtime optimizers have an **alternative**: optimize offline and
ship JSON state using the [recipe](../../packages/adapter-pyodide/README.md#runtime-optimizers-and-the-offline-recipe).
`rt-opt-bootstrap`, `rt-opt-mipro` and `rt-opt-copro` end `unsupported` in both
lanes; `rt-opt-gepa` ends `unsupported` natively and `executor_error` in the
Worker without `gepa`. Each makes zero requests. The existing seven offline-state
cases are unchanged; verified producers include LabeledFewShot, scripted-LM
BootstrapFewShot, ReAct demos and an instructions-only stand-in.

Runtime `LabeledFewShot` is **supported** in `rt-opt-labeled` and
`rt-opt-labeled-two-stage`: after compile, rebind `GalaxieLM`, then use `acall`.
Output, model payloads and seeded demos match plain DSPy; fresh-Worker replay
sends nothing before the frontier and then makes one second-stage request.
The naive copy without rebind ends `executor_error` with zero requests.
All probes leave zero tasks and post-termination requests. No prediction diverged,
so the conditional shipped refusal did not fire. No core contract change is needed.

The earlier thread-start evidence is reused. Blocking the single Worker's bridge
reply loop would starve cancellation and budget checks; that is reasoning, not
a measured blocking bridge. Author code must be deterministic apart from
journaled calls. Chromium, Firefox and WebKit runtime probes, real models, other
DSPy versions, offline MIPROv2/COPRO/GEPA output, KNNFewShot/Ensemble/SIMBA/
BetterTogether/fine-tuning optimizers and optimizers given an in-Worker plain
`dspy.LM` remain unmeasured. Shipped source, goldens, matrices, locks and Decision
text are unchanged. ADR-0012 controls are unchanged; this ADR stays Proposed.

### DSPy provider strings, schema output, embeddings and retrievers spike (2026-11)

The [provider probes](../../tests/conformance/README.md#dspy-provider-strings-schema-output-embeddings-and-retrievers-spike)
record provider-string LMs **alternative**, native provider schema output
**alternative**, embeddings **refused** and service retrievers **alternative**.
Scripted native/Node evidence uses DSPy 3.4.1, CPython 3.14.5, Node 24.15.0 and
Pyodide 314.0.7; no shipped source or core contract changes.

`pe-lm-runtime-set` and `pe-lm-runtime-context` each attempt one rejected loopback
connection natively, outside the router; Node ends `executor_error` with no fetch
attempts. lm15 defaults to sockets, not LiteLLM or automatic FetchTransport.
Prepare validation and syntax-only lint do not block runtime construction, as
decision 9 permits trusted code to bypass the bridge. Use a host-mapped
`GalaxieLM(role)`; `pe-control-routed` proves payload parity and `pe-lm-kwargs`
refuses per-call sampling parameters. Host configuration owns those parameters.

`pe-schema-response-format` refuses before a request. Typed-field replacements
have parity without `jsonSchema`; invalid typed output ends `executor_error`
after one response without retry. Provider constraints through the existing
router feature remain follow-up work. `pe-embed-*` fail without requests:
LiteLLM and NumPy are absent, there is no embedding role, and retrieval returns
passages, not vectors. `pe-retrieve-colbert` is outside the broker and fails;
it records zero Node fetch attempts locally on macOS and one rejected loopback
fetch in Ubuntu 24.04 CI (Node 24.22.2; CPython 3.14.6 native references),
without an unexpected target or bridge request. The exact
transport difference is unmeasured. This observed Worker path calls for a
follow-up decision on fail-closed handling under decision 9, not a changed outcome.
`pe-retrieve-local-rm` works on bundled passages. Use the existing host-bound RAG
capability replacement and the [author recipes](../../packages/adapter-pyodide/README.md#provider-strings-schema-output-embeddings-and-retrievers).

The Worker package probe finds `requests` but not `httpx`; native CPython has
both. The committed predictions remain unchanged beside these differences.
New Chromium, Firefox/WebKit probes, real models/services, other DSPy versions,
LiteLLM/declared-provider routes, Databricks/Weaviate, vector capabilities,
undeclared roles and multimodal shapes remain unmeasured. Prior Chromium evidence
is reused only for existing goldens/RAG cases. ADR-0012 controls and Decision text
are unchanged; this ADR remains Proposed.

### LangGraph Python tool-call replies spike (2026-11)

#### Outcome rule registered before measurement (2026-11-12)

One executor, six cells. Today every tool shape on this lane is refused (U1 re-verifies). "Candidate" means the smallest shape a host could own, measured as a test-local copy first (KTD3): (a) `GalaxieChatModel.bind_tools(tools, *, tool_choice=None)` that admits only tools created by (c) and returns a bound runnable carrying `options.tools` and `options.toolChoice` (`auto`, `none`, `required`, or one tool name); (b) message conversion that maps assistant `tool_calls` to `toolCalls` and a `ToolMessage` with text content to a tool-role message with `tool_call_id`, and reply `toolCalls` to `AIMessage.tool_calls` with parsed JSON-object arguments and unchanged IDs, streamed deltas to `tool_call_chunks`; (c) `capability_tool(name, capability, parameters, description)` returning a `StructuredTool` whose coroutine calls `galaxie.capabilities.call(capability, input, config, tool=True)`, converts only `denied` into fixed model-visible text and re-raises every other code; (d) a proxy-side latch: the first non-`denied` code a helper tool observes is stored in a slot keyed by the run (the effect-scope root taken from the config's `langgraph_checkpoint_ns` or `checkpoint_ns`, or the thread ID in `configurable` when that is the only Python-visible run key) and every later `GalaxieChatModel` request or helper call carrying the same key re-raises it before any bridge request. The slot is never a plain module global and is not a ContextVar that the `ToolNode` child tasks cannot propagate to the model node (the Worker driver does not set `capabilities.failures`, and `worker.ts` is out of bounds). If no Python-visible run key exists that lets the model node and the tool coroutine agree without a driver change, the latch is not built and G4.5 is recorded `fail`. The native reference is CPython with the pinned LangGraph, a scripted tool-calling `BaseChatModel` and the prebuilt `ToolNode`. Each scenario uses scripted models and counted capabilities.

Gates are measured in the order listed. A gate passes only when the favourable condition holds. A gate that states a fact expected to be the failing result is recorded `fail` when observed.

C1 bind and non-streaming reply (read capability tool; prebuilt `ToolNode` loop and a hand-written loop):

- N1 (native oracle): on native CPython record the ordered message list with tool-call IDs, projection of `AIMessage.tool_calls` and `ToolMessage`, whether a coroutine tool receives its `config`, the `checkpoint_ns` of two parallel calls in one reply, and the default error handler rule. N1 fails if prebuilt `ToolNode` cannot run in the pinned Worker wheel set (then C1 is decided by AL).
- G1.1 (wire fidelity): requests carry `options.tools` equal to the helper's declarations in order (names, descriptions, JSON Schema), `toolChoice` as mapped, assistant `toolCalls` with JSON-string arguments, tool-role messages with `tool_call_id`; replies become `tool_calls` with the same IDs and parsed arguments.
- G1.2 (routing): through core and Node Pyodide, a role whose provider declares `tool-calling` and has `bindTools` runs the loop; a role without the feature fails before dispatch with zero provider calls; a provider with no `bindTools` fails `unsupported`.
- G1.3 (parity): final state, message projection (type, content, id, tool-call name, arguments and id), stream modes and paths, ordered broker calls and counters equal the native reference on Node Pyodide; every difference is a named row.
- G1.4 (reply validity): a non-object or non-JSON `arguments` string, a duplicate call ID in one reply, an empty name, and a call naming a tool that was not offered each fail fixed `invalid` at the proxy before any tool body runs.
- G1.5 (unchanged behavior): tool-less text calls, schema-constrained calls and streaming text calls match the existing goldens and tests unmodified; a history holding tool parts with no `bind_tools` call is decided and recorded.

C2 streamed reply:

- N2 (native): record `tool_call_chunks` shapes from a scripted streaming tool-calling model and the merged `tool_calls` of the aggregated chunk.
- G2.1 (delta mapping): bridge `toolCalls` deltas become `tool_call_chunks` (index, id, name, args) so LangChain's chunk merge equals the native merged `tool_calls`; a final reply that disagrees with the merged deltas fails `invalid`.
- G2.2 (checked growing text): split arguments and growing IDs are checked before forwarding; a blocked fragment never reaches Python, no tool body runs, the run ends `denied`.
- G2.3 (features): a streamed tool call requires both `streaming` and `tool-calling`; a provider lacking either fails before dispatch.
- G2.4 (stream projection and close): `messages` stream events carrying tool-call chunks stay inside the existing bounded projection; cancel and close mid tool-call stream drain as text streams do.

C3 confirmed write:

- G3.1 (confirm and run once): a write bound with `approval: 'confirm'` and host confirmation coverage runs only after host approval, exactly once, on the frozen arguments; model text or tool output cannot approve.
- G3.2 (denial): a declined confirmation returns fixed model-visible text, the loop continues bounded by `steps` and `toolCalls`, and the host write count is zero.
- G3.3 (refused bindings): a write without `approval: 'confirm'`, a write with no confirmation coverage and an unbound capability each fail fixed `invalid` with zero host writes and end the run.
- G3.4 (mapping difference): schema-invalid model arguments end the run `invalid`, unlike the JavaScript helper's model-visible text. This is expected to be a recorded difference, not a failure of the cell; it fails only if the bridge reports distinct codes (then the candidate follows JavaScript).
- G3.5 (cancel while waiting): cancelling or aborting while a confirmation is pending settles `cancelled`, leaves no unsettled lease and no write.

C4 safety floor. G4.1, G4.2, G4.4, G4.5 and G4.6 are floor gates (veto, see decision rule):

- G4.1 (output check): blocked tool-call arguments or IDs fail `denied` before the tool runs and before any broker call, non-streaming and streaming.
- G4.2 (tool-call budget): with `limits.toolCalls = n` the call n+1 fails `budget_exceeded` before host dispatch and ends the run under the default `ToolNode`.
- G4.3 (step budget): an endless tool loop ends `budget_exceeded` through the recursion limit with a bounded number of broker calls and no model call after exhaustion.
- G4.4 (labels): a `private-user` result returned to the model is not sent to a destination the label policy refuses; the next model call fails `denied` with zero provider dispatch, as on the JavaScript lane.
- G4.6 (latch scope): after a run ends through a latched terminal code, a fresh run on the same prepared adapter and Worker, including one for a different session, issues model and capability requests normally; the latch is cleared or never matches the new run's key.
- G4.5 (swallowed failures): with `ToolNode(handle_tool_errors=True)` and with a callable handler, a terminal broker code (`budget_exceeded`, `cancelled`, `timeout`, `unavailable`, `outcome_unknown`, `unrecoverable`) observed by a helper tool still ends the run through the latch: no model request, helper call or host write follows. The residual shape (the graph never makes another proxy request) is recorded as a limit.

C5 durability and effect identity:

- G5.1 (parallel calls): two calls in one reply get distinct effect IDs and receipts, stable across a replay of the same step.
- G5.2 (crash after write): the Worker is disposed after a host write but before the `ToolMessage` checkpoint; recovery re-runs the node and the host write count stays one (journal receipt).
- G5.3 (restore): a graph that interrupts after a completed tool loop restores with a fresh Worker and a byte store; the completed tool node does not re-run; final state equals a native reconstruction.
- G5.4 (serialization): `AIMessage.tool_calls` and `ToolMessage` round-trip through `GalaxieCheckpointer` within the 1 MiB bridge message; an oversized tool result fails fixed `unsupported` without a partial checkpoint.

C6 refused neighbours (each with zero bridge requests and a fixed code, no argument or content text in any error):

- G6.1: a plain `@tool` function, a callable, an OpenAI-format dict and a pydantic class in `bind_tools`; `with_structured_output` through function calling; kwargs other than `tool_choice`; a `tool_choice` outside the four forms; two tools with one name; a name outside `[A-Za-z_][A-Za-z0-9_]{0,63}`; a tool schema larger than the bridge limit.
- G6.2: multimodal content blocks in a human, AI or tool message; `ToolMessage` with non-string content, `artifact` or error status; a `ToolMessage` whose `tool_call_id` matches no earlier call.
- G6.3: native `bind_tools` on a model that is not `GalaxieChatModel` and direct trusted `capabilities.call` stay outside the guard and are documented as such, not refused.

AL (alternative, shared by C1 to C5): the documented text-protocol recipe, where a node asks the routed model for a JSON tool request in plain text, parses it and calls `galaxie.capabilities.call(name, input, config)`, runs under a scripted model whose reply carries the call as JSON text instead of a tool-call part and yields the same ordered broker calls, the same write-once count and the same final text as the native tool-call run. Its limits (no `ToolNode`, no schema-constrained choice, no streamed tool deltas, direct calls are not subject to the helper's `tool: true` policy check) are stated in the docs.

Decision rule, per cell:

- SUPPORTED iff every gate of its family passes, measured; no public surface beyond R5 changed; the shipped change, conformance cases and new goldens landed; refusals updated at every enforcement point.
- ALTERNATIVE iff not SUPPORTED, no new surface beyond R5 is needed, and AL passes for the cell's scenario.
- REFUSED otherwise. A failed or unmeasured gate never yields SUPPORTED. The cell keeps (or gets) an executable refusal test and the record cites the failing gate.
- Floor veto: if G4.1, G4.2, G4.4, G4.5 or G4.6 fails, no source ships and C1, C2, C3 and C5 are decided by AL.
- Dependency: C2, C3 and C5 can be SUPPORTED only if C1 is SUPPORTED (they need the loop). C4 is measured on the C1 candidate even if C1 later fails another gate.
- C6 is REFUSED when every listed refusal test passes. A listed shape that runs is a defect: record it, change no source, and list it in the PR body.
- A failing native gate makes the matching galaxie gates not applicable.

Predictions (registered with the rule; U6 restates them beside the measured results and names every one that did not hold):

- P1. Native facts: prebuilt `ToolNode` runs in the Worker wheel set (`langgraph-prebuilt` is in the inventory) and its default handler re-raises non-`ToolInvocationError` exceptions; coroutine tools receive `config`.
- P2. C1 is SUPPORTED: the bridge and adapter need no change; only the proxy does.
- P3. C2 is SUPPORTED: deltas map to `tool_call_chunks` and the JS-side checks already exist.
- P4. C3 is SUPPORTED with the G3.4 difference recorded.
- P5. C4: floor gates pass; G4.5 passes for graphs that call the proxy again after a swallowed failure and records the residual limit; G4.6 passes if a run key is visible to Python, otherwise the latch is not built and G4.5 fails (which vetoes shipping, see P8).
- P6. C5 is SUPPORTED on CPython and Node Pyodide; Chromium reload stays unmeasured.
- P7. C6 is REFUSED for every listed shape.
- P8. Overall at least one SUPPORTED cell, so U7 lists follow-ups. A failing floor gate (including G4.5 or G4.6) would flip C1, C2, C3 and C5 to ALTERNATIVE and ship no source.


Additive entries in the Python compatibility matrix and conformance case lists, separate tool-case projections and new native-recorded goldens are permitted; existing entries, fixtures, case names, golden bytes, locks and other executors remain unchanged.

#### Measured outcome (2026-11-12)

The rule was committed before probes in `aa1dd896e8dc8a7230b50db0439f0167fba70069`.
Native evidence is in `2db3ae2`, the CPython candidate in `78f0434`, and real
Node Pyodide/core evidence in `84c6638`. No candidate is promoted: the
swallowed-failure floor failed. No production source, existing golden, case list,
stored format, identity derivation or lock changed; no wheel rebuild was needed.

| Cell | Outcome | Measured replacement or refusal |
| --- | --- | --- |
| C1 bind and non-streaming reply | ALTERNATIVE | A node validates a JSON text request and awaits direct broker calls. Read and ordered read/write requests match native ordered host calls, final text and write count. |
| C2 streamed reply | ALTERNATIVE | Collect checked JSON text before parsing; the read scenario matches native calls and final text. No streamed tool deltas are provided. |
| C3 confirmed write | ALTERNATIVE | Direct calls still wait for a host confirmation on frozen arguments; approval writes once, decline writes nothing and ends `denied`. |
| C4 safety floor | ALTERNATIVE | Plain nodes let terminal failures escape. The replacement ends `budget_exceeded` before host dispatch and refuses a subsequent host-server model dispatch after reading `private-user` data. The helper candidate fails containment below. |
| C5 durability and effect identity | ALTERNATIVE | With byte checkpoints and recovery, both a completed write followed by a pause and a writing node replayed after its pause restore through a fresh Worker with one host write overall. Ordered host calls and final text match the native tool-call reference. |
| C6 refused neighbours | REFUSED | The candidate refuses ordinary binding forms and unsupported message shapes before transport. Shipped native binding remains unimplemented; its exception-code discrepancy is recorded below. |

Gate results distinguish candidate measurements from replacement measurements:

| Cell | Gate | Observed fact | Result |
| --- | --- | --- | --- |
| C1 | N1 | Prebuilt and hand-written native loops preserve call order and IDs; async tools receive config. The pinned prebuilt wheel also imports and runs in the Node Worker. Default `ToolNode` rethrows ordinary exceptions. | Pass |
| C1 | G1.1 | CPython candidate carries declarations in order, maps all four choices, retains call IDs/arguments and emits tool-role history. | Pass in CPython only |
| C1 | G1.2–G1.5 | Full routing, projection parity, malformed-reply and unchanged-behavior candidate gates were not completed. Unchanged shipped tests were run separately. | Not measured: outcome fixed by G4.5 |
| C2 | N2 | Two scripted argument fragments merge to the non-streaming native call, including its ID and JSON arguments. | Pass in CPython |
| C2 | G2.1–G2.4 | Candidate delta mapping, growing checks, feature requirements, projection and close/cancel gates were not run. | Not measured: outcome fixed by G4.5 |
| C3 | G3.1–G3.5 | Candidate confirmation, binding refusals, schema-invalid mapping and cancellation gates were not run. Replacement confirmation tests do not establish these helper gates. | Not measured: outcome fixed by G4.5 |
| C4 | G4.1–G4.4 | Candidate output-check, tool/step-budget and label gates were not run. Replacement budget/label tests do not count as candidate floor passes. | Not measured: outcome fixed by G4.5 |
| C4 | G4.6 | No latch exists, so isolation of a latched failure cannot be measured. A subsequent successful run on the same prepared Worker is a separate observation. | Not applicable: latch not built |
| C4 | G4.5 | Public model/tool task namespaces differ; removing task components leaves an empty root. `thread_id` repeats across executions; the driver supplies no public execution ID. Explicit boolean/callable handlers turn a terminal failure into an error-status `ToolMessage`. The candidate refuses that history as `unsupported`, losing the original code, and a later helper still reaches the bridge. | Fail |
| C5 | G5.1–G5.4 | Candidate parallel identity, crash-after-write, tool-message restore/serialization and oversized-result gates were not run. Parallel native calls share one tools namespace. | Not measured: outcome fixed by G4.5 |
| C6 | G6.1 | Candidate rejects plain tools, callables, OpenAI dicts, pydantic classes, function output, unknown kwargs/choices, duplicate/invalid names and oversized schemas before transport. | Pass for candidate; shipped bind-code discrepancy below |
| C6 | G6.2 | Candidate rejects multimodal human/AI/tool content, non-string tool content, artifacts, error status and orphan IDs before transport, with fixed content-free codes. | Pass for candidate |
| C6 | G6.3 | Native model binding remains outside this proxy. Replacement tests exercise direct trusted capabilities with no helper `tool` flag. | Boundary retained |
| C1–C5 | AL | Four CPython replacement scenarios and Node read/text-stream/write, budget/label and fresh-Worker restore/replay scenarios run as described above. | Pass for the listed scenarios |

The CPython failure matrix covers `budget_exceeded`, `cancelled`, `timeout`,
`unavailable`, `outcome_unknown` and `unrecoverable` under both explicit handlers;
Node reproduces `unavailable` under both and demonstrates a later host capability
dispatch. No module-global or child-task `ContextVar` latch was substituted. The
residual graph that swallows a failure and makes no further proxy request remains
outside any proxy latch's observation; it is not claimed as contained.

Premise verification passed 63 unchanged CPython tests and 127 Node
adapter/Pyodide/JavaScript-tool tests. The proxy has no binding implementation,
rejects tool history as `unsupported` and reply `toolCalls` as `invalid`; the
adapter refuses an unsolicited tool reply. One premise prediction was too broad:
inherited `bind_tools` raises `NotImplementedError`, not fixed Python
`unsupported`/`invalid`. The Worker maps uncaught construction failure to
`unavailable` and run failure to `executor_error`. This existing normalization
gap is retained and handed off, rather than changing source after the veto.
No pre-existing LangGraph Python binding or ToolNode fixture was found. Graphs
are constructed at Worker boot, so host prepare never sees their tool list.

| Prediction | Observation |
| --- | --- |
| P1 native facts | Held: prebuilt inventory, config injection and default rethrow confirmed. Parallel calls share the tools task namespace. |
| P2 C1 supported | Did not hold: floor veto; text-protocol alternative only. |
| P3 C2 supported | Did not hold: floor veto; checked text streaming alternative only. |
| P4 C3 supported with mapping difference | Did not hold: floor veto; candidate schema-invalid mapping is unmeasured. |
| P5 floor passes with a run-scoped latch | Did not hold: no common execution key was established under the permitted public config fields; G4.5 failed and no latch was built. |
| P6 C5 supported | Did not hold: floor veto; direct-call restore/replay alternative only. Chromium reload remains unmeasured. |
| P7 neighbours refused | Refusal held for measured shapes. Shipped binding lacks the predicted fixed Python error code. |
| P8 at least one supported cell | Did not hold: no source shipped; the registered fallback branch was taken. |

All six cells were reached; the unmeasured support-family gates above are
intentional early stops, not passes. Evidence uses LangGraph 1.2.16,
langgraph-prebuilt 1.1.1, langchain-core 1.7.0, CPython 3.14.5, Node 24.15.0
and Pyodide 314.0.7, with scripted models only. New Chromium reload, Firefox,
WebKit, real models, other framework versions and other executors are unmeasured.
No new goldens are awarded to alternatives. The adapter
[author recipe](../../packages/adapter-pyodide/README.md#langgraph-python-model-chosen-calls-through-text)
states the missing ToolNode/schema-choice/tool-delta behavior, sequential calls,
uncaught-error requirement and direct-call tool-policy limit. Decision 3 and
ADR-0012 remain unchanged; this ADR stays Proposed.
