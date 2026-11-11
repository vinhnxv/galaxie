# ADR-0020: Google ADK (JavaScript) through an executor adapter that owns the Runner

- **Status:** Accepted (maintainer decision, 2026-11-08)
- **Date:** 2026-11-03
- **Related:** brief §6.2, §7.4; ADR-0002, ADR-0005, ADR-0012, ADR-0016, ADR-0017, ADR-0018, ADR-0022 (the Python sibling), ADR-0023 (the Go sibling)
- **Revisions:** 2026-11-03: created with the stage A1 foundation (decision, dependency pin, bundle-load probe); probe findings recorded. 2026-11-03: stages A2 to A6 evidence recorded (run loop, streaming, interactions, durable sessions, agent shapes). 2026-11-08: accepted. A real-model demonstration on one device is recorded in the [ADK recipes record](../adk-recipes-real-model-record.md); the Python and Go siblings (ADR-0022, ADR-0023) stay Proposed until each has a real-model run, and the adapter order is JavaScript, then Python, then Go.

## Context

Agent authors ask for Google's Agent Development Kit. ADK 2.x for JavaScript ships a browser bundle: `dist/web/index_web.js` in `@google/adk` is one self-contained 1.3 MB file with `@google/genai`, zod and lodash inlined and no external imports, selected by the `browser` export condition. The engine can therefore load in a page. Left to itself, an ADK agent bypasses galaxie in four ways:

- A model given as a string resolves through ADK's registry to the `Gemini` class and Google endpoints with an API key.
- Built-in tools (`GoogleSearchTool`, `LoadWebPageTool`, OpenAPI and REST toolsets), `RemoteAgent` and `AgentTool` reach the network or start a second `Runner`.
- Sessions live in ADK's own services, outside the app/principal scoping, fencing and retention rules of `@galaxie-ai/storage-indexeddb`.
- Pauses (tool confirmations, long-running tools) surface only as ADK events.

ADR-0017 asks each framework to arrive as its own executor adapter without a core change. `adapter-langgraph` and `adapter-pyodide` are the precedents. ADK shares nothing with the Pyodide bridge or LangGraph state.

## Decision

1. **A new package.** `@galaxie-ai/adapter-adk` implements `ExecutorAdapter` with id `adk-js`. Core keys executors by id and records `executorId` in `RecoverySession`, so core needs no change and never names ADK.
2. **One bundle, one specifier.** The adapter imports `@google/adk` only. The `browser` export condition resolves it to `dist/web/index_web.js`. No `@google/adk/...` subpath is imported at runtime (`a2a`, `tools/mcp`, `tools/webmcp`, `sessions/database`, `artifacts/gcs`, `telemetry/gcp`, `agents/agent-engine`), and `@google/genai` is imported only as a type, because the bundle inlines its own copy. `scripts/check-dependencies.ts` enforces both rules. The peer and development dependency is exactly `@google/adk` 2.3.0, the newest release that satisfies the workspace `minimumReleaseAge` on the day this ADR was written. A bump is separate work that re-runs the symbol-presence and bundle-hash tests and the conformance lane.
3. **The adapter owns the Runner.** The agent factory receives a host object with `capabilities.call` and ADK helpers: a router-backed model (`GalaxieLlm extends BaseLlm`) and capability-backed tools. The adapter builds the `Runner`, a session service, no-op artifact, memory and credential services, one `ToolCallIntegrityPlugin` and the `RunConfig`. Authors never see the Runner and cannot supply plugins, services or a `RunConfig`.
4. **Fail-closed tree validation.** At prepare the adapter walks the agent tree against a closed allow-list of agent classes (`LlmAgent`, `SequentialAgent`, `ParallelAgent`, `LoopAgent`). Every model and tool must be a member of a module-private registry the host fills when it creates them. ADK's brand guards test a forgeable `Symbol.for` brand and are not used for trust. `RemoteAgent`, `LangGraphAgent`, `RoutedAgent`, `Workflow`, `AgentTool`, author `BaseAgent` subclasses, toolsets, code executors and string or `Gemini` models fail `unsupported`.
5. **Pauses end the run; resume is a new run.** ADK ends an invocation at a tool confirmation or a long-running tool and resumes when the next `runAsync` carries the matching `functionResponse`. The adapter maps one pause to one galaxie interaction whose ID is a digest of the conversation ID and the pause ordinal. The default resume fails closed: it confirms only on the exact action `approve`, denies only on `deny`, and fails `invalid` otherwise. ADK's confirmation processor and the integrity plugin stay enabled.
6. **Effect scopes are positional.** Capability calls use `adk/<conversation-id>/<branch-or-root>/<branch-local-index>/<part-index>`. Function-call IDs never key an effect, because ADK invents IDs when a model omits them and local models reuse them. The adapter assigns every function-call ID itself.
7. **Sessions are persisted through the byte-record port.** An in-memory `GalaxieSessionService` holds the event log. At each pause and at completion it writes one `adk.session/v1` record with an `__interrupt__` write through the existing scoped port, so fencing, retention, deletion and export rules apply. The saver's closed byte-executor set gains `adk-js`. A per-session random integrity key stored in that record lets restored events verify; it is never exported or logged.
8. **Fatal errors do not become model text.** ADK turns model errors into ordinary final events and re-wraps tool errors as model-visible responses. Each run owns a failure slot that records the first fatal galaxie error and aborts the invocation; only `denied` and validation failures reach the model.
9. **Framework output stays content-free.** The adapter installs a no-op ADK logger, keeps ADK span content capture off, and emits its own allowlisted spans.
10. **Executor features.** `streaming`, `interrupts`, `resume` and `checkpoints` are true, and `subgraphs` is false: ADK sub-agent events carry `author` and `branch`, which are not LangGraph namespaces, and nested pauses and stream paths have no parity cases. Each flag turns on only with its evidence (see Verification).

## Alternatives considered

- **Let authors build the Runner.** Rejected: plugins, services, `RunConfig` and `AgentTool`'s own Runner would bypass the step limit, the integrity plugin and the session scope.
- **Trust ADK's `isBaseLlm` and `isFunctionTool` guards.** Rejected: they test a forgeable `Symbol.for` brand, so an agent could present any object as a galaxie model or tool.
- **Key effects by ADK function-call ID.** Rejected: IDs are random or reused, so a replayed run could repeat a write.
- **A shared tool-call check module for all adapters.** Not built: adapters may not import each other and core may not name LangChain. A local mirror plus a shared case table repeats the Pyodide precedent.
- **Import the Node build with polyfills.** Rejected: it reaches `fs`, `child_process`, database drivers and Google auth, which the strict CSP and the no-backend mission exclude.

## Consequences

- A fourth executor id (`adk-js`) needs one new member of the saver's byte-executor set and a new conformance lane; other lanes, goldens and matrices stay unchanged.
- The adapter pins one ADK release. ADK's dependency tree (auth libraries, database ORM, OpenTelemetry SDKs) enters the lockfile but never a bundle, because only the web file is imported; a built-host bundle-content test guards that.
- ADK's OpenTelemetry API is inlined in the bundle and registers through the shared global, so a host-registered provider receives ADK's own content-free spans in addition to galaxie's.
- Author code inside a registered tool, and agent-level model callbacks, remain trusted (ADR-0002). The adapter does not re-check a response a callback replaces.
- Live and bidirectional streaming and multimodal parts are unsupported.

## Verification

- **Stage A1 probe (2026-11-03), ADK 2.3.0.** One tool-calling agent (scripted `BaseLlm` stub, a `FunctionTool` with a repo zod 4.6.7 schema) runs through `InMemoryRunner` on Node and in headless Chromium, with fetch, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon` replaced by throwing stubs. The Chromium page is served with the example host's strict mock policy (`script-src 'self' 'wasm-unsafe-eval'`, `require-trusted-types-for 'script'`, `trusted-types 'none'`, no `unsafe-eval`). Findings:
  - **No policy relaxation is needed.** The run completes with no CSP or Trusted Types violation, no network request, no call to the global `Function` constructor, no `process` global and no page error.
  - **zod must be put in jitless mode before the bundle is evaluated.** The bundle inlines zod, whose allows-eval probe runs `new Function('')` and trips the Trusted Types sink. The bundle shares `globalThis.__zod_globalConfig` with the repo's zod, so `config({ jitless: true })` fixes it, but only if it runs before the bundle module evaluates, not before the first parse. A side-effect-only import of that configuration is dropped by a bundler in a package marked `"sideEffects": false`, so the host entry (not the adapter package) owns it. A control page without it fails with exactly one Trusted Types sink violation per probe site.
  - **A repo zod 4.6.7 schema satisfies the bundle's internal guards**: the `FunctionTool` executes and the tool receives the model's argument.
  - **`process.env` handling is two separate cases.** A Vite build replaces `process.env` with `{}` inside the bundle, so no run-time shim can reach the flag: ADK span content (prompts, replies, arguments, results) is captured by default, and a host turns it off with the build-time define `process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` set to `"false"`. Tests prove both the default capture and the define. Where `process.env` is not replaced (a dev server's optimized dependencies, the Vitest browser lane), the bundle reads it without a guard once a tracer is registered; with no `process` global that throws `ReferenceError`, and ADK converts the throw into an ordinary final event with `errorCode` `UNKNOWN_ERROR`, which decision 8 must not let reach the model as text. `ensureAdkRuntimeEnv` (`src/runtime-shim.ts`) creates a frozen, non-enumerable, env-only `process` only when none exists, or sets the flag to `'false'` only when the key is unset, and exposes no real environment data. With a tracer registered and the shim, the lanes record no content.
  - **The bundle's OpenTelemetry API is inlined.** It registers through the shared global, so a host provider registered before the bundle is evaluated receives ADK's own spans (`invocation`, `invoke_agent`, `call_llm`, `execute_tool`). Without a context manager the spans exist but carry no attributes, because ADK writes them to the active span.
  - **The web file is pinned**: SHA-256 `e5090e3c76b35fbeba9d07403e0e534732f12ae586bed9f5558c09d4170ea199`; an `es-module-lexer` pass finds no static or dynamic import in it, and the exports used by the adapter are present.
  - **Since measured**: the `crypto.subtle`-dependent integrity plugin runs in the Node and Chromium lanes (stage A3 and later). **Still unmeasured**: Worker-hosted runs and real model providers.
- **Stages A2 to A6, observed.**
  - **Parity.** Twelve scripted cases (text, capability, sequential tools, output schema, denial, argument block, step budget, abort, two streaming cases, approve and deny) match goldens written by native ADK runs on Node and in Chromium. Shapes (`SequentialAgent`, `LoopAgent`, `ParallelAgent`, transfer) match native model requests and output.
  - **Fatal errors.** ADK's ordinary final event for a model error never reaches the model as text; the first fatal galaxie error aborts the invocation and fixes the run's result code.
  - **Pauses.** ADK resumes directly at the paused agent only when that agent and all its ancestors are `LlmAgent`s; otherwise it restarts from the root, and a `SequentialAgent` or `LoopAgent` runs from its first child. The adapter allows a pause when every ancestor is an `LlmAgent` (including a sub-agent reached by transfer), or when each step down from the root is the first child of a `SequentialAgent`. A pause anywhere else, in a tree containing a `ParallelAgent`, or by an unknown or duplicate-named agent fails `unsupported`. Native ADK showed the restart for `SequentialAgent`; the loop case follows ADK's resumption code and is refused on that basis.
  - **Durable sessions.** A pause and each completed conversation are one `adk.session/v1` record. Restore validates a closed schema, registers restored text as private data on every run, ties a stored pause to the stamped calls, and rebuilds the integrity plugin from a stored key kept in record metadata, so exports never carry it. Failed and cancelled runs write nothing. Chromium tests use a real `IndexedDBSaver`; Node uses in-memory byte records.
  - **Effects.** Position-derived scopes replay a write receipt after a crash, including for two parallel branches re-dispatched with reversed arrival.
- **Still unmeasured:** Worker-hosted runs, real model providers, the example host and the real-device checks every executor lists as open.
- **Required before Accepted:** a conformance lane comparing native ADK runs with galaxie runs for text, tool calls, streaming, confirmations, long-running tools, restore and fatal errors; a credential scan and a span-content scan over those runs; fault tests for the byte-record port with the `adk-js` tag; and the real-device or real-model checks that every other executor still lists as open.

### AgentTool spike (2026-11)

#### Outcome rule registered before measurement (2026-11-12)

The candidate is an adapter-owned `AgentTool` subclass that starts an isolated inner
Runner while sharing the outer run's routing, step counter, failure slot and abort
signal. The base shape has a string request, no inner schemas, one tool-wrapper
level, read-only inner capabilities and an inner root with its own host-created
model. Inner agent classes stay within the existing allow-list.

The prediction is **SUPPORTED**, subject to all seven gates below passing on Node
and Chromium with scripted models. Every base-shape gate is mandatory: any failure,
including result/state parity or pause refusal, makes the outcome **REFUSED**.
Unmeasured evidence is never a pass. Once a base-shape gate fails, later gates may
be recorded as unmeasured without changing that outcome. A failing optional shape
can be excluded only if the remaining base shape passes every gate and the excluded
shape has an executable refusal test. No shipped adapter changes precede that
SUPPORTED decision; prototype changes stay in the test tree.

| Gate | Required evidence | Prediction |
| --- | --- | --- |
| G1: native premise | Native request order is outer, inner, outer; final inner text is the tool result; declaration and subclassing work. | Pass |
| G2: routing | Every model call leases the router, shares steps, checks output, and later outer leases enforce inner capability labels. | Pass |
| G3: isolation and IDs | Separate inner sessions and fresh integrity keys; no inner events in outer storage or stream; no ID reuse after reload or retry. A test-local maximum-ID seed may model the proposed seed fix. | Pass |
| G4: state and result | Copied state, non-temporary state deltas and final text match native behavior. | Pass |
| G5: failure | Inner fatal errors and cancellation end the whole run with the expected code before any tool result reaches the next outer model call. Capability denial and invalid input remain model-visible. | Pass |
| G6: refusal | Prepare rejects pausing tools, writes, nested wrappers, schemas, Workflow, foreign classes, a model-less inner root and raw AgentTool. A runtime pause backstop also fails closed. Test-local validation may model the proposed registry additions. | Pass |
| G7: durability | Outer history survives save/reload/continue; a failed outer turn rolls back all of that turn's events. | Pass |

Nested pauses, nested wrappers, inner schemas, pausing or write tools, Workflow and
raw ADK AgentTool are predicted to remain refused. Two simultaneous wrapper calls
are an optional shape to measure separately. An inner fatal failure must end the
run, even if native ADK instead returns an empty tool result. No real endpoint or
credential is part of this experiment. Python and Go extension decisions await the
recorded outcome; neither executor changes in this spike.
