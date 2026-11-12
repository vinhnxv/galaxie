# ADR-0020: Google ADK (JavaScript) through an executor adapter that owns the Runner

- **Status:** Accepted (maintainer decision, 2026-11-08)
- **Date:** 2026-11-03
- **Related:** brief §6.2, §7.4; ADR-0002, ADR-0005, ADR-0012, ADR-0016, ADR-0017, ADR-0018, ADR-0022 (the Python sibling), ADR-0023 (the Go sibling)
- **Revisions:** 2026-11-03: created with the stage A1 foundation (decision, dependency pin, bundle-load probe); probe findings recorded. 2026-11-03: stages A2 to A6 evidence recorded (run loop, streaming, interactions, durable sessions, agent shapes). 2026-11-08: accepted. A real-model demonstration on one device is recorded in the [ADK recipes record](../adk-recipes-real-model-record.md); the Python and Go siblings (ADR-0022, ADR-0023) stay Proposed until each has a real-model run, and the adapter order is JavaScript, then Python, then Go. 2026-11-12: the AgentTool wrapper spike registered its outcome rule before measurement and recorded REFUSED; prepare-time read-only admission was not established. 2026-11-12: the workflow-child resume spike registered its outcome rule before measurement and recorded REFUSED; the routing-only seam did not establish last-child admission. 2026-11-12: the confirmation-beside-calls and request-input spike registered its outcome rule before measurement and recorded Python ordinary-sibling support and an input alternative; Go memory-only invalid-answer loss fails its stronger gate and all other cells are refused; production source is unchanged. 2026-11-12: the stream-namespaces, Workflow-agents and subgraphs-flag spike registered its outcome rule before measurement; the result below records message-attribution alternatives for Python and JavaScript, all Workflow cells refused, and every subgraphs flag unchanged. 2026-11-12: the string-models, toolsets, code-executors, planners and built-in-tools spike registered its outcome rule before measurement.

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

### Confirmation-beside-calls and request-input spike (2026-11)

#### Outcome rule registered before measurement (2026-11-12)

Cells (G = gap, E = executor). Today's state is what the premise tests re-verify:

| Cell | Shape | Today |
| --- | --- | --- |
| A-js | gated call G plus ordinary call W in one turn | refused (`PauseTracker`) |
| A-py | same | shipped, unit-tested, no conformance case |
| A-go | same | shipped, unit-tested, no conformance case |
| B-js, B-py, B-go | gated call G plus long-running call L in one turn, either call order | refused |
| C-js | `adk_request_input` call by an `LlmAgent` | refused at pause time |
| C-py | `adk_request_input` | no helper; reachable only as a long-running capability tool named that way |
| C-go | `adk_request_input` | ADK Go v1.9.0 ships no such tool |

Shapes per gap, each asserted with approve and deny: A1 `[G, W]`, A2 `[W, G]`, A3 `[W1, G, W2]` where W is a read; A4 the same with W a write capability under the recovery store and host confirmation; B1 `[G, L]`, B2 `[L, G]`; C1 one request with a message and a response schema.

Gates. N = native ADK of that language with its own `Runner` and scripted models; G = galaxie lane.

- NA1 (native continuity): after the answer, the next model request carries a result for every call of the turn, each ordinary tool body ran exactly once in total, G's body ran once on approve and never on deny, and on deny the model sees the rejection.
- NB1 (native combined answer): one user message answering both G's confirmation request and L's call yields a model request with L's real answer and G's outcome, L's body ran once, G's body once on approve and never on deny.
- NB2 (native split answer): record what ADK does when the two answers arrive in separate runs (informational; it decides whether ADR-0030 would be needed, and fails nothing by itself).
- NC1 (native input): after `adk_request_input` is answered, the `LlmAgent` model's next request carries the answer.
- GA1 (live parity): output, ordered model requests, capability calls and the published interaction match native. Exactly one interaction is published, listing only the gated call(s); no gated body runs before the answer.
- GA2 (reload): pause, dispose the runtime, build a fresh runtime over the same byte store: same interaction ID, same completion transcript as live, W not run again.
- GA3 (writes once): with the recovery store and host confirmations, host `invoke` count equals the logical write count across approve, reload, and an approve whose resume fails after the write and is retried; effect-scope strings equal those of an uninterrupted run of the same script with G ungated.
- GA4 (nothing skipped, nothing lost): deny never runs G; a partial answer (one of two requests, or a wrong kind) fails `invalid` before any body runs; the pause stays answerable.
- GA5 (refusals intact): every shape the cell does not accept still ends `unsupported` with no interaction published, no body run after the pause and the conversation rolled back; all existing tests and goldens pass unmodified (one exception: when A-js is decided SUPPORTED, the implementation replaces the sibling-refusal test in `packages/adapter-adk/test/interaction.test.ts` with an acceptance test; the long-running-sibling refusal test stays).
- GB1 to GB5: GA1 to GA5 for B1 and B2 with one interaction carrying two positional requests (a confirmation and a long-running one), answered together through the author's `resume` hook. L's capability reaches the host once even though it runs at call time.
- AL1 to AL3 (alternative, gap C and any cell that fails): AL1 the documented replacement runs in an executable test and the answer reaches the model; AL2 the interaction request carries the question and the author's `resume` validates the answer; AL3 reserved-name safety: a capability tool named `adk_request_input` is either refused at construction or proven harmless by a test.

Decision rule, per cell:

- SUPPORTED iff every gate of its family (A: NA1, GA1 to GA5; B: NB1, GB1 to GB5; C: NC1 and GA1 to GA5 shaped for a single input request) passes, measured, and the shipped change plus new goldens landed (implementation and documentation). For A-py and A-go the change is already shipped; SUPPORTED then needs only NA1 and GA1 to GA5 passing, plus the new conformance case with a golden.
- ALTERNATIVE iff not SUPPORTED, no new public API is needed, and AL1 to AL3 pass.
- REFUSED otherwise. A failed or unmeasured gate never yields SUPPORTED. The cell keeps (or gets) an executable refusal test and the record cites the failing gate.
- A native gate that fails (NA1, NB1, NC1) makes the corresponding G gates not applicable for acceptance: the adapter cannot repair ADK's loss of an answer without changing the model-visible history, which is in Considered and not built.

Predictions (registered with the rule; the record restates them beside the measured results and names every one that did not hold):

- P1. A-py and A-go: NA1 and GA1 to GA5 pass; SUPPORTED. The Python result already matches the unit test.
- P2. A-js: NA1 fails on ADK 2.3.0 because a sibling's result is dropped from the model request after the confirmation answer (the matrix note). Outcome REFUSED. If NA1 passes, A-js proceeds to implementation and must pass the full family.
- P3. B on all three: NB1 fails or NB1 passes but GB3 fails because L's capability would run again on resume; outcome REFUSED. Python is the executor where NB1 is most likely to pass (`flows/llm_flows/core/_resume.py` handles several calls per event), so Python gets measured first and decides whether Go and JavaScript repeat it. NB2 is recorded either way.
- P4. C-js: NC1 fails (ADK hides the answer); ALTERNATIVE through `capabilityTool({ longRunning: true })` with an author `resume` hook, which `interaction.test.ts` already exercises.
- P5. C-py: NC1 passes natively; no helper ships (R5); ALTERNATIVE through `capability_tool(..., long_running=True)` with an author `resume`; AL3 is open (the name `adk_request_input` passes the `_TOOL_NAME` pattern today).
- P6. C-go: REFUSED, with the reason that ADK Go v1.9.0 ships no request-input tool; this is a source fact, not a measurement, and is recorded as such.
- P7. Overall: at least one ALTERNATIVE and at least one SUPPORTED (A-py, A-go), so a follow-up is required. Firefox, WebKit and real models unmeasured.

#### Measured outcome (2026-11-12)

The rule and predictions above remain as registered in `c1543e3`, before any probe.
The premise check in `768a60e` passed the shipped Python and Go ordinary-sibling tests
and the JavaScript refusal tests on Node and Chromium. Ordinary siblings were already
accepted by Python and Go; they were never uniformly refused across the executors.
Python native evidence is in `768a60e`, executor measurement in `4932963`, JavaScript
native/executor evidence in `02ad09e`, and Python conformance in `03854cd`.

Python evidence uses native ADK 2.12.0's own Runner in
`tests/conformance/cases-adk-python/test_adk_python_confirmation_beside_calls.py`
and the shipped executor in `python/galaxie/tests/test_adk_beside_calls.py`.
The latter uses a fake host receipt journal: its write counts and host confirmations
are executor measurements, not a new core broker integration test.

| Python cell | Gate | Observed fact | Result |
| --- | --- | --- | --- |
| A-py | NA1 | Both call orders and two ordinary siblings retain every result; ordinary bodies run once; approve runs G once and deny runs it zero times with a model-visible rejection. | Pass |
| A-py | GA1 | Live ordered requests, capability results and one positional interaction match native. No gated body runs before the answer. | Pass |
| A-py | GA2 | Fresh executors restore the same interaction from bytes; siblings do not run again. Six new Node Worker goldens match both live and fresh-Worker completion. | Pass |
| A-py | GA3 | Every measured sibling shape preserves ungated effect scopes and one fake-host invocation/confirmation per logical write across live, reload and failed-resume retry. | Pass, fake journal scope |
| A-py | GA4 | Deny omits G; partial and wrong-kind answers fail `invalid` without bridge calls and leave the pause answerable. | Pass |
| A-py | GA5 | Existing unit refusals remain; both long-running call orders refuse before any capability and roll back events. All 39 native goldens verify; all 79 focused Node conformance tests pass. | Pass |
| B-py | NB1 | Either combined-answer order loses L's real answer: the next model request retains its pending marker. | Fail |
| B-py | NB2 | Either split order eventually delivers both outcomes, with a model call between the answers. | Informational |
| B-py | GB1–GB5 | Native combined-answer continuity fails, so no candidate tracker patch is built and no accepted mixed-pause scenario exists. | Not applicable |
| C-py | NC1 | Native `request_input` delivers the answer to the `LlmAgent` model. | Pass |
| C-py | GA1–GA5 | No native request-input helper mapping ships; the existing long-running capability path is measured as a replacement. | Not measured for native mapping; not supported |
| C-py | AL1 | A long-running capability and author resume deliver the input answer live and after byte restore. | Pass |
| C-py | AL2 | The four-field interaction carries the question/schema; malformed city answers fail `invalid` before a bridge call and leave the pause answerable. | Pass |
| C-py | AL3 | A long-running capability named `adk_request_input` delivers the answer live and after restore without collision. | Pass |

A-py is **SUPPORTED** by the already shipped implementation, now with six new
native/live/restored conformance cases and goldens. B-py is **REFUSED** after NB1;
the pre-check and both call-order refusal tests remain. C-py is **ALTERNATIVE**
through `capability_tool(..., long_running=True)` with a validating author resume;
no request-input helper or new public API ships. The
[author recipe](../../packages/adapter-pyodide/README.md#asking-for-input) describes
the replacement and its limits.

JavaScript evidence uses native ADK 2.3.0's own Runner in
`packages/adapter-adk/test/confirmation-beside-native.test.ts` and the shipped adapter
through the runtime in `confirmation-beside-measure.test.ts`. All 29 cases pass on
Node and headless Chromium (58 executions). These tests assert the observed losses;
passing tests do not turn the failed continuity gates into passes.

| JavaScript cell | Gate | Observed fact | Result |
| --- | --- | --- | --- |
| A-js | NA1 | Both call orders and two siblings run ordinary bodies once, but their results disappear from the post-answer model request. Approve/deny still govern G. | Fail |
| A-js | GA1–GA5 | Native continuity fails; no candidate relaxation or stored accepted sibling pause exists. The shipped refusal still publishes no interaction or gated invocation and rolls history back. Ordinary siblings may already have run before refusal. | Not applicable to acceptance |
| B-js | NB1 | Either call order loses the real long-running answer when both are answered together, for approve and deny. | Fail |
| B-js | NB2 | Both split orders eventually deliver both outcomes after an intermediate model call. | Informational |
| B-js | GB1–GB5 | Native combined-answer continuity fails; no mixed-kind candidate or stored mixed pause is built. Existing refusals remain. | Not applicable |
| C-js | NC1 | The `LlmAgent` model never sees the native request-input answer. | Fail |
| C-js | GA1–GA5 | The native input gate fails; no native-input mapping candidate exists. The helper refuses without invoking a capability. | Not applicable |
| C-js | AL1 | An ordinary long-running capability delivers the input answer to the model. | Pass |
| C-js | AL2 | Its interaction carries the question/schema and a validating resume rejects malformed answers before another model call. | Pass |
| C-js | AL3 | A capability named `adk_request_input` is admitted, invokes its read capability once, then fails `unsupported` without an answerable interaction. | Fail |

A-js, B-js and C-js are **REFUSED** under the registered rule. The ordinary-name
long-running input path works, but AL3 prevents classifying C-js as an alternative.
Authors must use a non-reserved name. Construction-time reserved-name admission is
follow-up work; this spike adds no guard and changes no production source.

Go measurements are in `5d9c80b` (`go/galaxie/beside_calls_test.go`), using ADK
v1.9.0's own Runner independently of the galaxie executor. A later gate audit found
that the initial durable-only interpretation of GA4 narrowed the registered rule:
an invalid answer consumes a memory-only pause. A new executable characterization
pins that loss. The original persisted bytes remain recoverable, but that does not
make the unconditional gate pass. No production fix ships, as required for a defect
in already shipped ordinary-sibling behavior.

Provisional Go conformance in `3c49aec` passed six new native/Node/Chromium
live/restored references on pinned Go 1.27.3 (the first Worker run rejected the
machine's default 1.27.4). Those provisional cases, new goldens, matrix additions
and the test-only extra capability binding were then removed in corrective
commit `5f06317`: the failed gate makes this cell ineligible for the support implementation
unit. Existing Go conformance artifacts remain byte-identical. These discarded
probes establish no shipped Go support outcome and do not change the fixed rule.

| Go cell | Gate | Observed fact | Result |
| --- | --- | --- | --- |
| A-go | NA1 | Both orders and two ordinary siblings retain every result for approve/deny. Ordinary bodies run once; G runs once only on approval, with rejection visible on denial. | Pass |
| A-go | GA1 | The shipped executor's ordered model results match native and publish one confirmation-only interaction before G runs. | Pass |
| A-go | GA2 | A fresh Store restores the same pause from bytes without rerunning siblings and retains ordered native results. The provisional Worker cases were removed after GA4 failed. | Pass, byte restore |
| A-go | GA3 | Fake host receipts and approvals preserve write counts and ungated effect scopes live, after byte restore, and after failed-resume retry, including denial. | Pass, fake journal scope |
| A-go | GA4 | Partial/wrong-kind answers fail `invalid` without new work, but consume a memory-only pause; a valid retry is `stale`. Original persisted bytes remain answerable in a fresh Store. | Fail: memory-only answer lost |
| A-go | GA5 | Existing refused shapes remain. Both mixed long-running orders publish no interaction and run no gated body; native/wasm vet, native/race tests and existing conformance references pass unchanged. | Pass |
| B-go | NB1 | Either combined-answer order keeps the pending marker instead of L's real answer, for approval and denial. | Fail |
| B-go | NB2 | Either split order eventually delivers both outcomes in three model calls. | Informational |
| B-go | GB1–GB5 | Native combined-answer continuity fails, so no candidate observer patch or accepted mixed pause is built. | Not applicable |
| C-go | NC1, GA1–GA5, AL1–AL3 | The pinned module contains no `adk_request_input` or `request_input` symbol/tool. No native mapping or replacement is measured for this cell. | Source fact; runtime gates not applicable |

A-go is **REFUSED** under the spike rule after GA4, while shipped approve/deny
behavior continues to accept ordinary siblings. This is a recorded defect, not a
new runtime refusal. No new Go conformance cases or golden files ship. B-go is
**REFUSED** after NB1 and C-go is **REFUSED** by pinned-source absence. Every executor was reached in Python, JavaScript, Go order. There is no
unmeasured executor to extend in this attempt; other versions and the browser/device
gaps below require the same gates before claiming support.

The Python ordinary sibling runs before the ADK confirmation answer. Its own host
write confirmation remains independent and required. The measurement's succeeded
receipt journal prevents repeated host invocation on retry; without matching recovery
storage, writes can repeat. Output checks, grants, labels, host confirmations and
the broker path are unchanged. No candidate rewrites the model-visible history or
depends on ADR-0030's proposed serialized publication contract.

Admission is enforced where the calls become known, rather than uniformly at prepare:
JavaScript observes the pause at run time; Python rejects the mixed long-running turn
in its model-response pre-check. No enforcement point changes because no previously
refused cell becomes supported. This corrects the original prepare-validation premise.

P2 and P3 hold for the measured executors, and P5 holds for Python. P4's predicted
JavaScript alternative does **not** hold: NC1 fails as predicted, but AL3 also fails.
P1 holds for Python within the documented fake-journal write scope, but does
**not** hold for Go: durable recovery hid the memory-only GA4 failure during the
initial measurement. P6 holds as a Go source fact. P7's minimum of one supported
and one alternative outcome holds through A-py and C-py. A follow-up is
required; its filing is left to the orchestrator and the PR carries the notes.

No real model took part. Python's six new goldens have native CPython and Node
Pyodide evidence; the new input/write measurements have CPython evidence only.
JavaScript's new probes ran on Node and headless Chromium; Go's new conformance
provisional cases ran natively and on Node and Chromium with restore, then were
removed after GA4 failed; final Go gate evidence is native scripted measurement
and unchanged regression conformance. Dedicated Chromium
coverage for the new Python shapes, Firefox, WebKit and device checks remain
unmeasured. A pinned ADK version change must rerun the native and executor
measurement files as well as conformance; these outcomes do not predict other versions.

### Stream namespaces, Workflow agents and subgraphs spike (2026-11)

#### Outcome rule registered before measurement (2026-11-12)

Cells (G = gap, E = executor). The premise check re-verifies today's state:

| Cell | Question | Today |
| --- | --- | --- |
| A-js, A-py, A-go | do `author` / `branch` map to stable nested stream paths and checkpoint namespaces | every stream event has `path: []`; `subgraphs` false |
| B-py | host an ADK 2.12.0 `Workflow` with Parallel-branch effect-scope rules | refused at prepare (`_validate`) |
| B-js | host an ADK 2.3.0 `Workflow` | refused at prepare (`validateAgentTree`) |
| B-go | host a Workflow | ADK Go v1.9.0 appears to ship none |
| C-js, C-py, C-go | may the executor's `subgraphs` flag be true | false |

Trees and graphs. Each is driven by native ADK with its own `Runner` and by the galaxie lane, with scripted models and counted capability tools.

- Gap A trees: T1 root `SequentialAgent` [drafter, reviewer]; T2 `ParallelAgent` [left, right] with reversed arrival; T3 `ParallelAgent` [`SequentialAgent` [a, b], c] (branch composition); T4 `LoopAgent` (two iterations) [worker]; T5 `LlmAgent` root transferring to a sub-agent; T6 the same agent name in two different subtrees; T7 each already-accepted pause position (first, middle, nested Sequential leaf; a single confirming Parallel branch) with reload.
- Gap B graphs: W1 chain START to a to b; W2 fan-out a to [b, c] into a `JoinNode`; W3 route-labeled branch; W4 cycle that revisits a node, and a node with a retry configuration that fails once; W5 an `LlmAgent` node that calls a write capability. Each LLM node uses a galaxie-registered model.

Tree-ancestry mapping candidate, restated as the gate subject: the stream path of an event is the list of agent names from below the root down to the authoring agent (root authoring gives `[]`); the namespace of a sub-agent is that path joined by `/`.

Gates. N = native ADK of that language with its own `Runner`; G = galaxie lane.

Gap A:

- NA1 (native facts and oracle): for T1 to T6 record, per event, `author`, `branch` and, on Python, `node_info.path` (informational). The oracle is a hand-written expected path list per tree and per event, written in the native test before the galaxie lane exists. NA1 passes when every observed native `author` equals the authoring agent of the hand-written expectation and every observed `branch` follows the P1 rule (it forks only at `ParallelAgent`). If observed native facts contradict the hand-written expectation, NA1 fails for that executor: the cell is REFUSED citing NA1 and its galaxie gates are not applicable. Record whether names collide in T6 natively. The oracle is tree-derived on all three executors, so GA2 is an implementation-consistency check, not independent parity, and the ADR says so.
- NA2 (branch sufficiency, informational): record whether `branch` alone separates sibling agents in each tree.
- GA1 (determinism): each stream event's path is identical across two runs of the same script, across a reload from the byte store (T7), and across a rebuilt tree (a second factory call).
- GA2 (consistency with the oracle): the galaxie path of each event equals the hand-written oracle path, compared as ordered sequences per path (Parallel arrival order may differ, as in the existing wire-list rule).
- GA3 (uniqueness and totality): distinct agents get distinct paths in T1 to T5. For T6 distinct paths must be proven without newly refusing any tree that prepares today. A mapping that is ambiguous for a tree the executor accepts fails the gate, and the cell is then at most ALTERNATIVE with the duplicate-name limit documented under AL3. A new prepare refusal of previously accepted trees is not a route to SUPPORTED, because authors' own agents and stored sessions outside this repository would stop preparing.
- GA4 (content-free): path segments are the tree's agent names only, and depth is bounded by the existing agent-tree depth limit (16); no model, tool-argument, capability-result or user text enters a path; stream checks, output checks and labels are untouched; no tree or name that prepares today is newly refused.
- GA5 (namespace stability): the namespace is derived at read time from stored `author` and the tree. No field is added to any stored record; stored bytes of every existing script, effect-scope strings and interaction IDs equal their pre-change values (string equality against the existing assertions); the namespace is the same before and after reload and after a tree rebuild; a stored pause whose pausing agent no longer exists in the rebuilt tree fails closed (record what happens today).
- GA6 (nested pause parity): for each T7 position the `paused` marker carries the pausing agent's path, the events before the pause and after the resume carry nested paths, the published interaction and its ID are unchanged, and the interaction count is unchanged.
- GA7 (unchanged artifacts): every existing golden is byte-identical; no existing assertion is weakened (the empty-path assertions change only for shipped supported mappings); no core change.
- GA8 (carriage): the path reaches the host-visible stream event: from `StreamProjector` output on JavaScript, through `adk-python-driver.ts` and `notify_stream_data` on Python (Node conformance lane over the real driver). GA8 can only be measured against shipped code, so it is measured in the shipping unit (see the two-phase decision below).
- AL1 to AL3 (alternative): AL1 a documented recipe (the host reads `data.author` of `messages` events and maps it through the author's own tree names) reproduces the oracle path for T1 to T5 in an executable test; AL2 it needs no new API, core, bridge or stored-format change; AL3 the docs state its limits (markers carry no author, Parallel interleaves, duplicate names are ambiguous, `node_info.path` is empty for agent children on Python).

Gap B (cell B-py first):

- NW1 (native facts): for W1 to W5 record the final output, per-event `author`, `branch`, `node_info.path` with run IDs, model-request counts and tool-body counts, including that a revisit and a retry produce new run IDs.
- NW2 (entry point, a gate): record what hosting needs: `Runner(node=...)` or an equivalent over the adapter's session service, integrity plugin and `RunConfig`; use a test-local seam only. NW2 fails when no routing-only seam exists; GW1 to GW6 are then not applicable (record the NW2 finding) and B is decided by AL-W alone.
- GW1 (closed list at prepare): a candidate prepare walk accepts only a static `Workflow` of galaxie-registered `LlmAgent` nodes, `JoinNode` and author function nodes, and refuses every other node kind, dynamic scheduling (`run_node`), parallel workers, retry or timeout settings, nested workflows and tool nodes, each with `unsupported` before any model call and a test per refusal.
- GW2 (routing): every model call from a node goes through the router and every capability call through the broker; ordered request digests equal native for W1 to W3.
- GW3 (effect-scope rule): capability calls use the Parallel-branch scope `adk-python/<conversation>/<branch-or-root>/<branch-local-index>/<part-index>`; fan-out nodes get distinct scopes; reversed arrival leaves every scope unchanged; a revisit of a node (W4) gets a new scope per visit while a re-dispatch of the same visit replays its receipt.
- GW4 (writes once): with the recovery store and host confirmations, host `invoke` count equals the logical write count across a normal run and a run that fails after a node's write and is retried with the same prompt.
- GW5 (no pause inside): a pausing tool anywhere under a `Workflow` is refused at prepare; native pause behavior is recorded as information.
- GW6 (conformance and artifacts): new cases and goldens only; existing artifacts unchanged.
- AL-W (alternative): a documented replacement for the static shapes W1 to W3 with `SequentialAgent` and `ParallelAgent` runs in an executable test with the same output and write-once behavior; the docs state what has no replacement (routes, cycles, retries).

Gap C (per executor X):

- GF1 (no hidden consumer): a search of `packages`, `tests`, `python`, `go` and `examples` shows `features.subgraphs` read only by descriptors and conformance assertions, so flipping it changes no run behavior.
- GF2 (A-X supported): A-X is SUPPORTED, including GA6.
- GF3 (browser evidence): at least one new nested-path streaming case and one nested-pause case pass in headless Chromium for X: the vitest browser project for JavaScript (`--project browser`); for Python `examples/rag-browser/test/adk-python-conformance.node.test.ts`, which runs only the cases listed in `adkPythonBrowserCases` (`tests/conformance/support/adk-python.ts`), so the new cases are registered there; for Go `examples/rag-browser/test/adk-go-reference.node.test.ts`. An unmeasured browser is not a pass.
- GF4 (consistency): the matrix `features`, the adapter `features`, the adapter tests and every doc sentence agree.
- GF5 (stated meaning): the matrix `limits`, `docs/unsupported.md`, `docs/status.md` and the adapter README each state, for X, what `subgraphs: true` means and does not: stream events from nested agents carry non-empty `path` (`messages`, tool markers and `paused`); effect scopes stay positional and are not keyed by the path; `PendingInteraction` carries no path; no namespace is stored. Verified by the U7 docs search. This keeps a host that reads the descriptor from inferring LangGraph-style checkpoint-namespace semantics.

Decision rule, per cell:

- SUPPORTED iff every gate of its family passes, measured, and the shipped change plus new goldens landed. For gap C, SUPPORTED means the flag is true and shipped.
- ALTERNATIVE iff not SUPPORTED, no new public API, core, bridge or stored-format change is needed, and AL1 to AL3 (gap A) or AL-W (gap B) pass. Gap C is ALTERNATIVE when its A cell is ALTERNATIVE: the flag stays false and the recipe is the documented replacement.
- REFUSED otherwise. A failed or unmeasured gate never yields SUPPORTED. The cell keeps (or gets) an executable refusal test and the record cites the failing gate. A gap C cell whose only failing gate is an unrun GF3 browser lane is recorded as REFUSED (browser lane not run) and the docs say exactly that, with no claim of technical impossibility.
- A failing native gate makes the matching galaxie gates not applicable for acceptance.
- Two-phase decision for gaps A and C. The measurement units record A as "measured-SUPPORTED" when every gate except GA8 passes on test-local evidence, and C as pending GF2/GF3/GF5. The shipping unit then ships the A change, measures GA8, runs the browser lane (GF3), and only then flips the flag. If GA8 fails, the A source change is reverted and A is recorded ALTERNATIVE or REFUSED by the rule. If GF3 fails or cannot run, A stays shipped (empty-path assertions replaced only for shipped supported mappings) and the flag stays false.

Predictions (registered with the rule; the shipping unit restates them beside the measured results and names every one that did not hold):

- P1. Native facts: `branch` forks only at `ParallelAgent` (`<parallel>.<child>`), so it cannot name Sequential, Loop or transfer children; `author` plus tree ancestry can; ADK Python 2.12.0 `node_info.path` is empty for `SequentialAgent`, `ParallelAgent` and `LoopAgent` children (probed) and non-empty only for `Workflow` nodes; ADK JS 2.3.0 and Go v1.9.0 agent events carry no node path; T6 is valid natively.
- P2. A-py: mapping gates GA1, GA2, GA4 and GA5 pass; the open gates are GA3 (T6) and the carriage change through `on_stream` and the Worker driver. Outcome SUPPORTED if GA3, GA6 and GA8 pass, otherwise ALTERNATIVE.
- P3. A-js: same as A-py with the tree available in-process to `StreamProjector`; outcome SUPPORTED if GA3, GA6 and GA8 pass, otherwise ALTERNATIVE.
- P4. A-go: the `agent` identity crosses the WebAssembly bridge only as a model-request field and the stream frames have no path field, so a path needs a bridge wire change (ADR-0023 scope). Outcome ALTERNATIVE (the `author` recipe) or REFUSED; not SUPPORTED.
- P5. B-py: native ADK runs W1 to W5, but `Workflow` owns scheduling, retry, dynamic nodes and rehydration, and the adapter may only add routing, so GW1 or GW3 on revisits is the likely failing gate (a probe shows fan-out nodes can run with branch `None`, while `_scope` counts a branch-local ordinal over all events sharing a branch, so reversed arrival may change scopes). Outcome ALTERNATIVE for the static shapes (AL-W); `Workflow` itself stays refused at prepare.
- P6. B-js: native ADK JS 2.3.0 also runs a `Workflow`; the galaxie lane repeats B-py's decision by extension unless the native facts differ, and the cell is then ALTERNATIVE or REFUSED, not SUPPORTED.
- P7. B-go: REFUSED by source fact if the pinned module ships no Workflow; recorded as a source fact, not a measurement.
- P8. C-js and C-py turn true only if GF3 browser evidence and GF5 exist; C-go stays false. If A is not SUPPORTED the flag stays false and the documented reason is rewritten to the measured one.
- P9. Overall: at least one ALTERNATIVE, so a follow-up is required. Firefox, WebKit and real models stay unmeasured.

Additive matrix entries, conformance registrations and new golden files are permitted for measured executors; existing entries and golden bytes stay unchanged except for the documented old-reason text replacements, empty-path assertions when a mapping ships, and the subgraphs flag only when its own gates pass.

#### Measured outcome (2026-11-12)

The rule was committed in `bcd4341` before any probe ran. Native Python evidence
is in `64b00bd`, Python executor measurements in `39d2f0d`, JavaScript measurements
in `41b1fb8`, and Go measurements in `2c3fa02`. These are characterization tests
with scripted models, not conformance goldens or new runtime support. The outcome
rule has not been adjusted to fit the observations.

| Cell | Outcome | Decisive evidence |
| --- | --- | --- |
| A-py | **ALTERNATIVE** | GA3 fails: two accepted leaves named worker under different Sequential subtrees emit indistinguishable author/branch pairs. AL1–AL3 establish message-only attribution for unique names. |
| B-py | **REFUSED** | Manifest-only GW1 admission cannot establish routing for author FunctionNodes. Full routed-graph AL-W parity is unmeasured; the partial static-tree recipe is insufficient for the whole family. |
| C-py | **ALTERNATIVE** | A-py is alternative, so GF2 prevents a true flag. The same message recipe is the replacement; subgraphs stays false. |
| A-js | **ALTERNATIVE** | GA3 fails on the same accepted duplicate-name tree. AL1–AL3 pass through host-visible messages on Node and Chromium. |
| B-js | **REFUSED** | Independent native JS facts differ from Python, but the manifest-only routing counterexample remains. Full AL-W parity is unmeasured. |
| C-js | **ALTERNATIVE** | A-js is alternative; subgraphs stays false. Chromium recipe evidence does not count as nested-path or nested-pause evidence. |
| A-go | **REFUSED** | The full NA1 oracle cannot run: native Runner construction rejects T6's globally duplicated names. This is a failed premise under the registered rule, not proof that mapping unique-name trees is impossible. |
| B-go | **REFUSED** | Source fact: pinned ADK v1.9.0 contains no workflow package or exported Workflow type. |
| C-go | **REFUSED** | GF2 is not established; A-go has no accepted full native oracle. The flag stays false. |

Premise verification passed before measurement: the JavaScript adapter tests ran
94 executions on Node and headless Chromium, the Python executor ran 208 CPython
tests and six native refused-shape tests, and `go test ./galaxie` passed. Every
shipped ADK stream path remains empty; all three descriptors and matrices retain
`subgraphs: false`. The search for feature readers found descriptors, reporting and
conformance assertions, with no ADK run behavior selected by the flag (GF1).
The existing Parallel receipt and restore checks remain regression evidence.
Literal searches of pre-existing ADK cases, goldens, examples and documentation
found no accepted duplicate-name or non-ASCII-name fixture; existing duplicate
pause-refusal tests do exist. The new tests exercise these previously uncovered
accepted Python/JavaScript trees. This search is not a census of external authors.

| Executor / gate | Observed fact | Result |
| --- | --- | --- |
| Python NA1, NA2 | T1–T6 match hand-written author/branch oracles. Only Parallel forks branches; Sequential and Loop children have empty node_info.path. Standalone transfer roots stamp root@1 and root@1/specialist@1. Non-ASCII identifiers run. | Pass; branch alone insufficient |
| Python GA3 | Accepted duplicate authors have different oracle paths but identical message identities. | Fail |
| Python GA1, GA2, GA4–GA8 | No candidate mapping ships after GA3; reload, pause-path and carriage gates are not measured. GA2 would test consistency with a tree-derived oracle, not independent namespace parity. | Not measured: outcome fixed by GA3 |
| Python AL1, AL2, AL3 | Five unique-name trees attribute real executor messages through an author-owned tree lookup; reversed Parallel arrival works. No API, bridge or stored field is added. Markers have no author; duplicate names are ambiguous. | Pass within message-only limits |
| Python NW1, NW2 | Native chain, fan-out/join, route, cycle, local retry, write and pause run. Fan-out writes use b@1/c@1 branches. Runner(node=...) shares the galaxie session service and an integrity plugin in the probe. | Native facts recorded; entry seam available |
| Python GW1 | A declared FunctionNode calls an unlisted scripted model directly. A static node-kind list alone cannot prove the required routing. This is not a proof against every possible adapter. | Not established |
| Python GW2–GW6 | No accepted closed-list candidate exists in this attempt. | Not measured: outcome fixed by GW1 |
| Python AL-W | Sequential/Parallel static replacements execute and replay writes after failure through a fake receipt journal. Routed-graph parity and host confirmation coverage are not established by that test. | Partial evidence; full alternative unmeasured |
| JavaScript NA1, NA2 | T1–T6 match native author/branch oracles, including reversed Parallel arrival. Agent-tree events have no nodeInfo path; duplicate names run. | Pass; branch alone insufficient |
| JavaScript GA3 | Two accepted leaves emit identical host-visible worker messages. | Fail |
| JavaScript GA1, GA2, GA4–GA8 | No mapping candidate ships; no nested pause or reload-path evidence is claimed. | Not measured: outcome fixed by GA3 |
| JavaScript AL1, AL2, AL3 | Host message attribution matches all five unique-name tree oracles on Node and Chromium with the unchanged API. Duplicate-name and marker limits remain. | Pass within message-only limits |
| JavaScript NW1, NW2 | Native chain, fan-out/join, route, cycle, local retry, write and pause run through its own Runner. Workflow events have dotted paths, such as wf.a; context runId increments on revisits. | Native facts recorded; differs from Python |
| JavaScript GW1 | A declared FunctionNode directly dispatches an unlisted scripted model. The shipped validator still rejects Workflow before dispatch. | Not established |
| JavaScript GW2–GW6, AL-W | No closed-list candidate; full routed-graph replacement not established. | Support gates not measured after GW1; full alternative unmeasured |
| Go NA1, NA2 | T1–T5 match the author/branch oracle. The native Runner rejects T6 at construction; the shipped executor also refuses before dispatch. Event has no NodeInfo field. | Full native oracle not established |
| Go GA1–GA8 | The full native prerequisite fails. Existing ModelRequest carries Author only, without Path, Branch or Tree; page projection uses an empty path. | Not applicable for acceptance |
| Go AL1–AL3 | A partial recipe over real streaming bridge request authors matches T1–T5; no host nested-path test or full native T6 exists. | Partial evidence; does not override NA1 |
| Go NW/GW/AL-W | No Workflow graph type exists in the pinned production sources, checked by an executable module walk and Go parser. Older workflowagents are present and supported. | Source absence; runtime gates not applicable |
| All GF1, GF4 | Feature-reader search and descriptors, matrices, assertions and docs agree on false. | Pass |
| Python/JavaScript GF2 | Gap A is alternative. | Fail for true flag |
| Go GF2 | Gap A full native oracle not established. | Fail for true flag |
| All GF3, GF5 | No source mapping ships, so no new nested-path/pause browser case or true-flag meaning is measured. | Not measured: outcome fixed by GF2 |
| All artifacts | No runtime source, core, effect scope, interaction ID derivation, stored schema, golden or lock changes. Matrices gain evidence entries only. Existing restore suites pass unchanged. | Regression and diff verification |

The message recipe maps an event's `data.author` through the author's own static
tree, keeping only globally unique names and returning their below-root ancestry.
It provides display attribution only. Tool and paused markers carry no author;
Parallel interleaves messages; duplicate names are ambiguous. No nested stream
path, checkpoint namespace, path on PendingInteraction or stored namespace is
created. Effect scopes remain positional. The Python fake receipt journal is not
evidence of host authorization or backend exactly-once effects; production grants,
output checks, labels, broker confirmations and restore admission are untouched.
For static chains/fan-out, authors may use SequentialAgent and ParallelAgent.
Dynamic routes, cycles and node retries have no demonstrated tree replacement
in this attempt; Workflow itself continues to fail unsupported at prepare.

Predictions that did not hold: P1's claim that T6 is valid on every language fails
on Go, and its Workflow-only Python node-path claim fails for standalone transfer
roots. P5's shared-branch fan-out suspicion is false for the measured LlmAgent
nodes: they have distinct branches. The NW1 new-run-ID prediction for local
retry is also false on both Python and JavaScript: retry reuses the visit ID.
P5/P6's whole-family Workflow alternative is not established; B-py/B-js are
refused under the rule because the remaining evidence is incomplete. P2/P3 resolve
to alternatives after GA3, P4's no-shipped-carriage prediction holds but its
alternative possibility is not accepted after the Go native premise fails,
P7 holds by source inspection, and P8/P9 hold (flags unchanged; message alternatives).

All executors were reached in Python, JavaScript, Go order. No measured-SUPPORTED
cell reaches the shipping unit; no source change, new golden, assertion replacement
or flag flip is eligible. There is no unmeasured executor to extend, but the skipped
support gates and full Workflow replacement remain unmeasured, not passed. A future
attempt must rerun the same fixed gates and cannot infer support from the partial
recipes. Follow-up notes belong to the PR: a duplicate-aware identity proposal,
closed-list Workflow admission and full route parity, Go's native-oracle revision,
and dedicated nested-path/pause browser evidence. Tracker filing is left to the
orchestrator for this run.

New evidence is CPython for Python, Node and headless Chromium for JavaScript,
and native Go for Go. Existing Worker/browser conformance remains regression
coverage only; no new Python or Go nested-path browser behavior is claimed.
Firefox, WebKit, real models and device checks remain unmeasured. A pinned ADK
version change must rerun the native and executor measurement files.

### String models, toolsets, code executors, planners and built-in tools spike (2026-11)

#### Outcome rule registered before measurement (2026-11-12)

Cells are gap letter plus executor: M-js, M-py, M-go, T-js and so on. Today every cell is refused at prepare (U1 re-verifies). Each candidate is the smallest shape a host could own. Native means the language's own ADK with its own `Runner`; galaxie means the executor lane. Each scenario uses scripted models and counted capability tools.

| Gap | Candidate to measure | Stays refused regardless |
| --- | --- | --- |
| M string and Gemini models | An `LlmAgent.model` string exactly equal to a role declared for the run is replaced, before validation, by that role's host-created model (the same object the `llm(role)` helper returns) | any other string, `Gemini` and foreign model instances, name-sniffing aliases |
| T toolsets | A toolset created and registered by the host, with a list fixed at creation made only of registered capability tools and no context-dependent output (measured with a test-local registration, no shipped helper) | MCP, OpenAPI, ApiHub, WebMCP, BigQuery and every author-defined or dynamic toolset |
| X code executors | None is a plausible candidate; the gap measures why none qualifies | all executors |
| L planners | None is a plausible candidate for `BuiltInPlanner`; `PlanReActPlanner` is measured once as the only prompt-and-response planner | all planners unless the gates pass |
| N built-in network tools | None is a plausible candidate; the gap measures the missing governance seam | all built-in tools, `load_web_page`, author-built network tools |

Gates. They are measured in the order listed, per executor. A gate passes only when the favourable condition holds (the seam exists, parity holds, the field is carried). GN1, GN2, GX2 and GL1 state a fact that is expected to be the failing result; the gate table records `fail` when that fact is observed, never `pass`.

Gap M:

- NM1 (native facts and oracle): record on native ADK how a string resolves (JavaScript `LLMRegistry.register` with `supportedModels`; Python `LLMRegistry.register` with `supported_models()`), whether resolution is at construction or lazy, whether `model` can be assigned after construction and takes effect (Python `_resolved_model` cache), and that a test-registered scripted class under a regex matching the role string runs the tree natively. That registered class is the parity oracle for GM3. NM1 fails when assignment is rejected or ineffective; the galaxie gates are then not applicable and M is decided by AL-M.
- GM1 (exact admission at prepare): an exact declared role is accepted. These fail `unsupported` at prepare with zero requests: an undeclared string, `gemini-2.5-flash` with no such role, a case variant, leading or trailing whitespace, the empty string with no model above it, the display names `galaxie:<role>` and `galaxie/<role>`, a non-string non-model object, a `Gemini` instance, a foreign `BaseLlm`. GM1 requires the executor to know the declared roles at prepare. An executor that cannot refuse an undeclared string at prepare fails GM1.
- GM2 (no ADK registry): a decoy model class registered natively under a pattern that matches the role string is never constructed in the galaxie lane; a spy on registry resolution sees zero calls; the registry's contents are identical before and after prepare and run.
- GM3 (routing equivalence): the string-mapped tree and the same tree built with the explicit helper produce identical ordered request digests, outputs, stream events, step and budget counters, output-check calls, labels and effect scopes, and match the native decoy run in the existing conformance comparison.
- GM4 (tree rules): strings at the root, on a child, mixed with model objects, inherited by a child with no model, and under a transfer parent behave as the helper-built tree does; a model-less agent with no model ancestor stays `unsupported`; one unmappable string refuses the whole tree before any call; exact-class refusals keep their codes (the class check runs first).
- GM5 (author-object effects): a second `prepare` of the same objects is idempotent; the only mutation is the `model` field of agents in the prepared tree; a tree shared by two hosts with different roles fails closed for the second host (record the result); the ADK registry and any module-level state are untouched.
- GM6 (name sniffing): with a host role named `gemini-2.5-flash`, the mapped model's name never satisfies ADK's Gemini-name predicates, and `GoogleSearchTool`, a planner and a code executor in the same tree are still `unsupported` at prepare.
- GM7 (identity and durability): stored bytes (`adk.session/v1`; the Python and Go records), effect scopes and interaction IDs of the mapped run equal the helper-built run's, across a reload.
- GM8 (unchanged artifacts): every existing golden, matrix entry and refusal test passes unmodified; the existing `'gemini-2.5-flash'` refusal rows still refuse (no role of that name is declared there).
- AL-M (alternative): a documented porting table (`model='x'` becomes `host.adk.llm('role')`, `llm('role')`, `galaxie.Model("role")`, with the host declaring the role) runs in an executable test under the same script and matches the native decoy run.

Gap T:

- NT1 (native facts): record for an author-defined static toolset: per-request `getTools` calls, `tool_filter` list and callable, name prefix, `close()` at runner close, and the function declarations in the model request. Network toolsets (MCP, OpenAPI, WebMCP) are recorded as source facts only; nothing connects.
- GT1 (fixed list): the test-local registered toolset yields only registered capability tools, a list fixed at creation, with no callable filter and a no-op `close`.
- GT2 (request surface): names, order, descriptions and schemas in the model request equal the flat-list equivalent and the native toolset run.
- GT3 (pause scan and effects): the pause-position rules see through the toolset (a confirmation-gated or long-running tool inside it is subject to the same refusals as in a flat list); capability calls, effect scopes and write-once counts equal the flat list's.
- GT4 (refused neighbours): an unregistered toolset, MCP, OpenAPI and WebMCP toolsets, a callable filter, a toolset that returns an unregistered tool, a nested toolset and a toolset whose `getTools` throws each fail `unsupported` before any model call.
- GT5 (no new surface): SUPPORTED needs no new exported symbol, option, descriptor field or bridge field. Creating a registered toolset needs a helper, so GT5 is expected to fail and the cell is then ALTERNATIVE.
- AL-T (alternative): the documented recipe builds a flat list of capability tools from a table in the agent factory (for MCP-backed tools, from the host's `tools-mcp` capability bindings); under the same script it produces the same request surface and results as the native toolset. The docs state what has no replacement: per-turn dynamic lists and network toolsets.

Gap N:

- NN1 (native facts): a built-in tool run natively with a scripted model that names itself like a Gemini model records: no function call is made, no ADK tool body runs, the request config gains the provider tool entry; with a non-Gemini name the tool throws (JavaScript) or errors (Python).
- GN1 (carriage): the galaxie router request has no field for provider tool config, so the entry would be dropped silently (record the request digest with and without the tool).
- GN2 (governance seam): no broker call, grant, destination class or data label applies to the provider's server-side work; nothing in the lane can enforce ADR-0012 on it.
- GN3 (refusal tests): one executable refusal per built-in family, per executor, with zero requests: search, URL context, Vertex or Discovery search, maps grounding, enterprise web search, `load_web_page` and an author function tool that calls `fetch`.
- AL-N: ALTERNATIVE requires a replacement that runs under the same unchanged script and matches the native outcome. A built-in makes no function call natively, so a capability-tool replacement needs a different script and cannot qualify. The docs still point to `capabilityTool` over a host-bound read capability as the general way to give an agent network data, labelled as guidance and not as this cell's outcome.

Gap X:

- NX1 (native facts): record, with a scripted model, what each executor does with a model reply holding a code block (extra model turn, result fed back), what `BuiltInCodeExecutor` adds to the request, and which executors need a subprocess, a container or a cloud service.
- GX1 (isolation seam): a probe shows whether model-written code can reach author scope or host capabilities (a sentinel variable and the `js` bridge in the Worker, the page globals in JavaScript); the Worker lane records whether a subprocess can start at all.
- GX2 (carriage): `BuiltInCodeExecutor` configuration is dropped by the router request (as GN1).
- GX3 (refusal tests): one executable refusal per executor family, per executor, with zero requests; Go records the absence of any executor field in `llmagent.Config` and the refusal of a `geminitool` code-execution tool.
- AL-X: no replacement can run under the same script without an isolation boundary, so ALTERNATIVE is not available unless GX1 finds one.

Gap L:

- NL1 (native facts): record `BuiltInPlanner` (thinking config on the request) and `PlanReActPlanner` (instruction text, tagged reply parts, thought-marked events) on scripted runs.
- GL1 (carriage and parity): thinking config is dropped by the router request; for `PlanReActPlanner` the streamed text, the final event and the stored event differ from a planner-less run under the same script.
- GL2 (stored schema and output check): the retagged parts fit the closed stored-record schema and the output check sees the text before the split, or the gate fails.
- GL3 (refusal tests): one per planner per executor, zero requests; Go records the absent field.
- AL-L: an instruction-text replacement qualifies only if it runs under the same script and matches the final text.

Decision rule, per cell:

- SUPPORTED iff every gate of its family passes, measured; no new public surface (R5); the shipped change, conformance cases and new goldens landed; prepare validation updated at every enforcement point.
- ALTERNATIVE iff not SUPPORTED (including because the SUPPORTED candidate would need new public surface), the replacement itself needs no new public surface, and the family's AL gate passes: a documented replacement whose executable test runs the same scripted model script unchanged and matches the author-observable result (final text, tool-call sequence, write-once host invocation count).
- REFUSED otherwise. A failed or unmeasured gate never yields SUPPORTED. The cell keeps (or gets) an executable refusal test and the record cites the failing gate.
- A failing native gate makes the matching galaxie gates not applicable.
- A shape inside a gap but outside its candidate keeps an executable refusal test and does not change the cell's outcome word.

Predictions (registered with the rule; U7 restates them beside the measured results and names every one that did not hold):

- P1. Native facts: strings resolve through each language's `LLMRegistry` and `model` is assignable after construction on JavaScript and Python; built-in tools, executors and planners only edit the request or the response; ADK Go v1.9.0 has no string model, planner or code-executor field.
- P2. M-js is SUPPORTED: `options.models.roles` is available at prepare, so GM1 to GM8 pass. M-py is ALTERNATIVE: the Worker driver does not know the declared roles at prepare, so GM1 fails for an undeclared string and the fix needs a bridge field (R5). M-go is REFUSED: Go has no string form, and a foreign `model.LLM` is the bypass the type assertion closes.
- P3. T-js, T-py and T-go are ALTERNATIVE: GT1 to GT4 pass on the test-local registration, GT5 fails (a helper is needed), and the flat-list recipe passes AL-T.
- P4. N-js, N-py and N-go are REFUSED: GN1 and GN2 fail, AL-N cannot hold.
- P5. X-js, X-py and X-go are REFUSED: GX1 finds no isolation boundary (and no subprocess in the Worker), GX2 drops `BuiltInCodeExecutor`; X-go is refused by source absence.
- P6. L-js and L-py are REFUSED for both planners (thinking config dropped; `PlanReActPlanner` fails GL1 or GL2); L-go is REFUSED by source absence. A deviation is possible if an instruction-only replacement matches the final text (then ALTERNATIVE).
- P7. Overall: at least one SUPPORTED (M-js) and several ALTERNATIVE, so U8 lists follow-ups. Firefox, WebKit, real models and Worker-hosted JavaScript stay unmeasured.

Additive entries in measured executors' matrices and conformance case lists, new fixtures, registrations and golden files are permitted; existing entries, fixtures, goldens and locks stay byte-identical, with documentation of changed refusal reasons recorded separately.
