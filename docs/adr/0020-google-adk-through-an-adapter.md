# ADR-0020: Google ADK (JavaScript) through an executor adapter that owns the Runner

- **Status:** Accepted (maintainer decision, 2026-11-08)
- **Date:** 2026-11-03
- **Related:** brief §6.2, §7.4; ADR-0002, ADR-0005, ADR-0012, ADR-0016, ADR-0017, ADR-0018, ADR-0022 (the Python sibling), ADR-0023 (the Go sibling)
- **Revisions:** 2026-11-03: created with the stage A1 foundation (decision, dependency pin, bundle-load probe); probe findings recorded. 2026-11-03: stages A2 to A6 evidence recorded (run loop, streaming, interactions, durable sessions, agent shapes). 2026-11-08: accepted. A real-model demonstration on one device is recorded in the [ADK recipes record](../adk-recipes-real-model-record.md); the Python and Go siblings (ADR-0022, ADR-0023) stay Proposed until each has a real-model run, and the adapter order is JavaScript, then Python, then Go. 2026-11-12: the AgentTool wrapper spike registered its outcome rule before measurement and recorded REFUSED; prepare-time read-only admission was not established. 2026-11-12: the workflow-child resume spike registered its outcome rule before measurement and recorded REFUSED; the routing-only seam did not establish last-child admission.

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
4. **Fail-closed tree validation.** At prepare the adapter walks the agent tree against a closed allow-list of agent classes (`LlmAgent`, `SequentialAgent`, `ParallelAgent`, `LoopAgent`). Every model and tool must be a member of a module-private registry the host fills when it creates them. ADK's brand guards test a forgeable `Symbol.for` brand and are not used for trust. `RemoteAgent`, `LangGraphAgent`, `RoutedAgent`, `Workflow`, `AgentTool`, author `BaseAgent` subclasses, toolsets, code executors and string or `Gemini` models fail `unsupported`. The [AgentTool wrapper spike](#agenttool-spike-2026-11) also remains refused: the proposed optional-tool-flag registry cannot enforce a read-only inner tree at prepare.
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

#### Measured outcome: REFUSED (2026-11-12)

The rule was committed as `ef90a64` before any probe ran. Native evidence was
committed as `cff169c`; test-local wrapper measurements and the gate table were
committed as `83c814e`. The prototype was then removed. The retained
[native tests](../../packages/adapter-adk/test/agent-tool-native.test.ts) and
[refusal characterizations](../../packages/adapter-adk/test/agent-tool-measure.test.ts)
run on Node and headless Chromium against the pinned ADK 2.3.0 web bundle. All models
are scripted; no real endpoint or credential was used. Firefox and WebKit were not
run for this spike.

| Gate | Observed evidence | Result |
| --- | --- | --- |
| G1 | Subclass override, native declaration, outer/inner/outer request order, inner tool execution, copied state and ordinary state deltas, session keying, two tool results and cancellation passed. Native inner model errors and confirmations returned empty tool results. | PASS |
| G2 | The prototype completed with three router leases. An inner call over the shared step limit failed `budget_exceeded`; blocked inner output failed `denied`. Inner capability labels reaching later outer leases were not measured. | UNMEASURED as a whole; partial evidence passed |
| G3 | The prototype used a separate inner session service and integrity plugin; no inner event appeared in the outer events. Fresh-key comparisons, stream/storage isolation and reload/retry ID uniqueness were not measured. | UNMEASURED as a whole |
| G4 | The prototype returned the same inner final text as native. Its copied state and forwarded state deltas were not measured. | UNMEASURED as a whole |
| G5 | Inner step-budget and output-block failures set the shared failure slot before any tool response reached the next outer model call. Other fatal errors and prototype cancellation were not measured. | UNMEASURED as a whole |
| G6 | An inner host tool for a write, with the optional `requireConfirmation` flag omitted, passed the proposed pause-set validation before any model call. Marking that same tool as pausing made the prototype refuse it, but the host does not infer that mark from the authoritative binding kind at prepare. | FAIL |
| G7 | Save/reload/continue and failed-turn rollback were not measured after the decisive admission failure. | UNMEASURED |

The predicted overall support and prepare-time write refusal did not hold. The
existing host helper checks `capabilityBindingPolicy` on the run's broker port when
the tool executes. It does **not** require the optional ADK `requireConfirmation`
flag at construction. The executor's prepare contract supplies model preparation,
not the run's capability port. A registry populated only by confirmation,
long-running and request-input flags therefore cannot distinguish an unflagged
read tool from an unflagged write tool. This fails the mandatory read-only admission
gate; it is not evidence that an unconfirmed write can execute. The real broker
still refused a confirmation-required write with no host confirmation coverage,
and the binding was never invoked.

The registered rule selects REFUSED after this base-shape failure; unmeasured gates
are not passes. No adapter source, core contract, conformance case, golden, matrix
or lock changed. Raw AgentTool still fails `unsupported` at prepare. Native ADK's
empty-string swallow is unsuitable for a future wrapper: an inner fatal error must
end the galaxie run with its fixed error code, as the measured output and step
failures did. The experiment did not establish the full failure contract.

**Extension decision:** do not port this candidate to adk-python or adk-go. First
resolve how an adapter-owned inner runner can enforce the host's authoritative
read-only binding policy before any inner work, then repeat all seven gates. A
runtime-only non-read refusal would be a different admission design and needs its
own rule and tests. Python and Go need independent designs and evidence after
that decision; their current refusals remain. Nested pauses additionally require
resumable inner state and branch-scoped effect scopes. Nested wrappers, inner
schemas, pausing tools, Workflow and raw AgentTool remain refused. The native
two-call result passed; concurrency of the proposed isolated wrapper is unmeasured.

### Workflow-child resume spike (2026-11)

#### Outcome rule registered before measurement (2026-11-12)

The candidate uses ADK 2.3.0's `resumabilityConfig: {isResumable: true}`
only when resuming a leaf in the last child chain of `SequentialAgent`s.
Existing first-child and transfer-chain pauses keep the default Runner. All
measurements use scripted models on Node and headless Chromium, without real
endpoints or credentials. Firefox and WebKit remain unmeasured.

Candidate shapes (sequences are `SequentialAgent`, loop is `LoopAgent`, tool is a
gated `capabilityTool` with `requireConfirmation: true` unless noted):

| ID | Tree | Today on adk-js |
| --- | --- | --- |
| W1 | `Seq[first(tool), second]` (control) | accepted (restart through first children) |
| W2 | `Seq[a, b(tool), c]` | refused |
| W3 | `Seq[Seq[inner(tool), b], c]` (first-child chain, control) and `Seq[a, Seq[b(tool), c]]` (nested, not first) | first accepted, second refused |
| W4 | `Seq[a, b(tool)]` and nested last chain `Seq[a, Seq[b, c(tool)]]`, plus a deny answer and two consecutive pauses by the same agent | refused |
| W5 | `Loop(2)[worker(tool)]` and `Loop(2)[writer, checker(tool)]` | refused |
| W6 | `Seq[Par[left(tool), right], merger]` in both arrival orders, `Seq[a, Par[left(tool), right]]`, and two confirming branches | refused |
| W7 | long-running tool: `Seq[a, b(long-running)]` (last) and `Seq[a, b(long-running), c]` (middle) | refused |
| W8 | transfer chain `LlmAgent[child(tool)]` (control); transfer target inside a workflow agent | first accepted, second refused |

Every gate is measured per shape and recorded as pass, fail, or not applicable
with a reason. Measurement must not stop at the first failure. A later gate may
be skipped only when the scenario no longer exists, such as a galaxie write-once
check for a shape already refused at pause time. An unmeasured gate is never a pass.

| Gate | Required evidence |
| --- | --- |
| N1: native continuity | With resumability on, after the answer every unfinished agent runs exactly once, no finished agent is asked again, and ordered model requests equal the uninterrupted ungated script. Parallel measures both arrival orders. |
| N2: native tool once | The gated tool body runs once per logical call. |
| N3: native state | Non-`temp:` state written before the pause is visible after resume; record `temp:` visibility separately. Informational: loss of `temp:` decides its admission refusal, not failure of the whole shape. |
| G1: live parity | With the test-only resumable Runner seam, output, ordered requests, capability calls and published interaction match native resumable. Exactly one interaction is published per pause; no capability runs before the answer. |
| G2: reload parity | Dispose and recreate the runtime over the same bytes (memory on Node, IndexedDB on Chromium); republish the same interaction ID and finish with the live transcript. |
| G3: writes once, scope stable | With recovery and host confirmations, host invoke count equals logical writes across approve, reload and approved-write/model-failure/retry. The resumed write's effect scope equals the uninterrupted write's scope. |
| G4: restore admission | A stored pause in a refused position fails `unrecoverable` before model or capability calls. Measure unchanged code first, then shipped code if the candidate proceeds. |
| G5: refusals and controls | Refused shapes end `unsupported` at pause, publish no interaction, execute no capability after pause and roll back. Controls use the default Runner with unchanged event logs. |

A shape is ACCEPTED iff N1, N2, G1, G2, G3 pass and G4 passes after the
conditional implementation, all measured. Any failed gate makes it REFUSED. An
unmeasured gate is a failure for acceptance and is recorded as unmeasured.
Controls (W1, W3 first chain, W8 transfer chain) never move to the resumable
Runner. If resumability fails N1 for a control, the record states that
resumability is shape-specific. The outcome is ACCEPTED-PARTIAL if at least one
shape passes (ship exactly that set, keeping executable refusal tests for the
rest), otherwise REFUSED. If W4's base last-child shape fails any gate, the
outcome is REFUSED, because every other shape is predicted to fail already.
No shipped source changes precede this decision.

Predictions, fixed before measurement:

- P0 (mechanism): resumability changes only routing; workflow agents write no
  `agentState`, `endOfAgent` or `nodeInfo`; the resumed branch agent has no context branch.
- Native under resumability: W1 FAIL N1 (the successor never runs), W2 FAIL,
  W3 nested-not-first FAIL, W3 first chain FAIL, W4 PASS (both variants), W5 FAIL
  (later iterations never run), W6 FAIL (the merger never runs, a cut-off sibling
  is never resumed, and in the reversed order its pending work is lost), W7 last
  PASS, W7 middle FAIL, W8 chain PASS (and unchanged).
- Galaxie: W4 and W7-last pass G1 to G3; W6 fails G3 even in an order where N1
  passes, because `sequenceOf` throws `invalid` for the branch-less resumed
  context; G4 FAILS on unchanged code (resume-time admission does not exist) and
  passes after the conditional implementation.
- Overall: ACCEPTED-PARTIAL. Accepted: a pause in the last child chain of
  `SequentialAgent`s (confirmation and long-running), leaf agent, no `temp:`
  output key anywhere in the tree. Refused: W2, W3 nested-not-first, W5, W6,
  W7 middle, transfer under a workflow agent. Firefox and WebKit unmeasured.

#### Measured outcome: REFUSED (2026-11-12)

The rule was committed as `c4df654` before any probe existed. Native evidence is
`e9fc623`, refined in `14bbada` to stop long-running tools after their pending
result, matching the adapter's cutoff. Adapter measurements are `834a1d1`.
The retained [native tests](../../packages/adapter-adk/test/workflow-resume-native.test.ts)
and [adapter characterizations](../../packages/adapter-adk/test/workflow-resume-measure.test.ts)
measure every candidate variant on Node and headless Chromium using the pinned
ADK 2.3.0 web bundle and scripted models. No real endpoint or credential is used.
Firefox and WebKit were not run.

The routing-only test seam is active: a first-child control resumes its author
alone and omits the successor, exactly as native resumability does. It does not
change the adapter's pause admission. Every new candidate therefore ends
`unsupported` before publishing or storing an interaction. This fails G1 for the
base last-child shape. Under the fixed rule, the outcome is REFUSED; the native
last-child result alone does not establish adapter support. This is a limitation
of the permitted experiment, not evidence that last-child support is impossible.

All gates were assessed before applying the decision. In the table, P is PASS,
F is FAIL and NA means the scenario does not exist, with reasons below. N1 and
N2 describe native resumability; G1 compares the routing-seam adapter with it.
The controls' production/default Runner remains unchanged. The G4 column is the
shared restore-admission gate, whose changed-tree and forged-action cases follow
the table; its pre-existing failure applies to every candidate's acceptance.

| Shape | N1 | N2 | N3 | G1 | G2 | G3 | G4 | G5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W1 first child | F | P | NA | P | P | P | F | P |
| W2 middle child | F | P | P | F | NA | NA | F | P |
| W3 first chain | F | P | NA | P | P | P | F | P |
| W3 nested, not first | F | P | P | F | NA | NA | F | P |
| W4 last approve | P | P | P | F | NA | NA | F | P |
| W4 last deny | P | P: zero bodies | P | F | NA | NA | F | P |
| W4 nested last | P | P | P | F | NA | NA | F | P |
| W4 two consecutive pauses | P | P: two bodies | P | F | NA | NA | F | P |
| W4 temporary output | P | P | temp lost | F | NA | NA | F | P |
| W5 loop worker | F | P | NA | F | NA | NA | F | P |
| W5 loop writer/checker | F | P | NA | F | NA | NA | F | P |
| W6 left asks first, then merger | F | P | NA | F | NA | NA | F | P |
| W6 right finishes first, then merger | F | P | NA | F | NA | NA | F | P |
| W6 Parallel is last | F | P | P | F | NA | NA | F | P |
| W6 both branches confirm | F | F: right body lost | NA | F | NA | NA | F | P |
| W7 long-running last | P | P | P | F | NA | NA | F | P |
| W7 long-running middle | F | P | P | F | NA | NA | F | P |
| W8 transfer control | P | P | NA | P | P | P | F | P |
| W8 transfer under workflow | F | P | P | F | NA | NA | F | P |

N3 is informational. NA N3 rows have no preceding state writer. Ordinary output
state survives into the resumed agent. Temporary output is trimmed even before
the next agent's initial request and is absent after resume too. Workflow events
in the uninterrupted, default and resumable lanes carry no `agentState`,
`endOfAgent` or `nodeInfo`. Resumability changes routing without preserving a
workflow continuation.

For example, the uninterrupted middle-child request order is `a,b,b,c`; default
resume produces `a,b,a,b,c`, and resumable routing produces `a,b,b`, omitting `c`.
A last child produces `a,b,b` uninterrupted and with resumability. Nested last,
deny and consecutive confirmation variants also retain native continuity.
Default native long-running workflow resume throws a missing-function-call error;
resumable last-child routing completes after the external response. The
long-running tool body runs before the pending result and external answer.

Both Parallel arrival orders lose the merger, and a last Parallel loses its
unfinished sibling continuation. With left asking first, the already pending
right tool body finishes after the consumer stops. Original left events have a
branch; the resumed tool context has none. The predicted branch-to-root adapter
scope failure cannot be reached through the permitted routing-only seam, because
the adapter refuses the pause first: W6 G3 is NA, not a measured `invalid` result.

NA G2/G3 rows have no published interaction or committed pause to reload, approve
or retry; an admission bypass would change the experiment. Every refused shape
is nevertheless driven through both unchanged and routing-seam adapters. Tests
assert `unsupported`, no interaction, no subsequent host invocation, no stored
checkpoint, and removal of the failed prompt before a fresh start. Long-running
bodies may execute before the refusal, behind the unchanged broker confirmation;
this is distinct from a host invocation after the pause. Existing first-child,
transfer and lone-agent controls retain their default routing. The first-child
and transfer controls additionally cover a successful reload with the same ID
and transcript, approved-write failure followed by automatic inbox replay in a
fresh runtime, one host write, and identical scopes on retry. Uninterrupted
reference scope comparisons normalize only the separately generated conversation
ID. Node stores bytes and recovery in memory; Chromium closes and reopens real
IndexedDB for these reload and retry checks.

G4 is measured against unchanged source. Since that source cannot store a
last-child pause, the producer is a supported lone agent named `b`; the same
stamped record is restored with `b` relocated in the consumer tree. Every case
republishes the original interaction before any model or capability call, leaves
stored bytes unchanged during restore, and fails the required early rejection:

| Consumer tree or forged action | Work after answering | Result |
| --- | --- | --- |
| Last child | Requests `a,b`; one `b` write; output | FAIL |
| Middle child | Requests `a,b,c`; one `b` write; output | FAIL |
| Loop | Requests `b,b`; one `b` write; output | FAIL |
| Parallel | Zero or one `right` request, depending on scheduling; no host write; `invalid` from scope mismatch | FAIL |
| Duplicate author name | Requests `b,b`; one write; output | FAIL |
| Unknown author name | One `other` request; no write; output | FAIL |
| `actions.agentState` | One `b` request and write; output | FAIL |
| `actions.endOfAgent` | One `b` request and write; output | FAIL |

The predicted overall ACCEPTED-PARTIAL outcome and W4/W7-last adapter G1–G3
success were not established. Native continuity predictions, the absence of
workflow state, loss of branch context and unchanged-code G4 failure held.
The predicted W6 adapter scope failure remains unmeasured in that direction;
the changed-tree restore test measures the reverse root-to-branch mismatch.
Conditional shipped-code G4 was not run, because no candidate reached the source
implementation unit. No admission function, resumable production Runner, restore
check or new conformance golden ships. Existing goldens, matrices, locks, core and
other executors remain unchanged. The seam remains only because the green
characterizations use it.

The intended admission update would occur at pause and restore time on adk-js,
rather than prepare time: the existing adapter cannot know which agent will pause
when preparing the tree. That timing deviation is recorded, but no admission
update ships on this refusal branch. Recommended follow-ups are a small separate
restore-admission and workflow-state refusal fix, and a newly pre-registered
experiment whose test-only seam can model both candidate admission and per-pause
Runner choice before last-child reload/write gates are measured. These are draft
recommendations, not tracker changes.

The `adk-go` extension remains record only: ADK Go 1.9.0 has no resumable
invocation. A galaxie-owned continuation design is a separate question. An ADK
JavaScript version bump must rerun the native and adapter evidence before any
workflow-pause rule is widened.
