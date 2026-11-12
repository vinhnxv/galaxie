# Conformance suite

The suite compares twelve deterministic graph cases in three lanes:

| Lane | Runtime and context | Test |
| --- | --- | --- |
| Native Node | Root `@langchain/langgraph` with native Node async context | [`native.node.test.ts`](native.node.test.ts) |
| galaxie on Node | The adapter's `/web` import with the synchronous context shim | [`galaxie.test.ts`](galaxie.test.ts), Node project |
| galaxie in Chromium | The same adapter and cases in headless Chromium, without Node polyfills | [`galaxie.test.ts`](galaxie.test.ts), Chromium project; [`browser-smoke.test.ts`](browser-smoke.test.ts) |

Only the native Node lane owns the files under [`golden/`](golden/). It normalizes generated IDs and timestamps and compares the transcript to its golden. The galaxie lanes compare normalized stream events, final state, checkpoint history, interrupts and resume against those same goldens. Both the in-memory saver and the IndexedDB saver cover `async`, `sync` and `exit` durability modes.

[`indexeddb.test.ts`](indexeddb.test.ts) reruns all twelve cases in Chromium with `@galaxie-ai/storage-indexeddb`. It requires exactly the existing `galaxie-chromium` matrix differences; it adds no matrix lane. Each test creates and deletes its own database. `runGalaxie` accepts an optional saver factory and a `stopAtInterrupt` flag for graph-level reload tests; existing callers keep the in-memory default.

The reload tests pause `interrupt-resume`, `interrupt-subgraph` and both durability cases through the runtime, dispose it, close the saver, and rebuild the graph over a new saver on the same database and thread. The pending interrupt ID and value, `value`, `answer` and `state.next` match the original pause and goldens. Rebuilt closure counters are asserted separately: `{ prepare: 0, ask: 1 }`, or `{ callSub: 1, s1: 0, sask: 1 }` for the subgraph. The native `interrupt()` driver uses `runWithConfig` after the fixture's await under the browser shim.

**Repeated completed resume baseline (LangGraph 1.5.1, checkpoint 1.2.0):** after another close/reopen and graph rebuild, submitting the same interrupt ID again leaves the final state unchanged and emits no node updates in all four reload cases. This observes the graph's behavior after a completed resume; a persistent submission inbox, effect reconciliation and runtime/UI session adoption remain later M3 slices.

[`compatibility-matrix.json`](compatibility-matrix.json) lists an observed case/lane difference as exact JSON paths with a reason. [`galaxie.test.ts`](galaxie.test.ts) requires the computed difference set to equal the listed set: an unlisted difference or a stale listed difference fails. [`support/matrix.ts`](support/matrix.ts) validates case/lane names, unique entries and paths, and non-empty reasons. The matrix records transcript differences; it is not an API inventory.

Additional tests in this directory run on both Node and Chromium unless their filename ends in `.node.test.ts` or they are the Chromium-only `indexeddb.test.ts`. They cover runtime controls beyond transcript parity. The single guarantee-to-code-and-test map is in [system design §9](../../docs/system-design.md#9-security-baseline-map).

## Static-breakpoint refusal and gate replacement

[`gate-replacement.node.test.ts`](gate-replacement.node.test.ts) owns three new
native Node goldens. [`compiled-breakpoints.json`](golden/compiled-breakpoints.json)
records before, after, both, wildcard and compiled-child pause settings, pending
nodes, zero checkpoint interrupts and root interrupt updates alongside the fixed
prepare refusal. [`gate-continue.json`](golden/gate-continue.json) and
[`gate-reject.json`](golden/gate-reject.json) record an explicit, separate
`requestInteraction` gate before work: continue runs work once; reject reaches
`END` without work. The request is content-free and the gate forwards node config
after an await.

[`gate-replacement.test.ts`](gate-replacement.test.ts) compares both gate
transcripts with zero differences on Node and Chromium, without a matrix lookup.
It checks prepare refusal before any node or checkpoint, core's fixed public
message, and the existing run-time backstop for invisible before/after/wildcard
overrides and a child invoked from a node body with forwarded config. Each ends
`unsupported` with no interaction or pending entry. Named overrides execute the
preceding node once; wildcard-before executes none. All measured pauses emit a
root interrupt, so no post-stream state check was added.

Memory-saver tests restore both gate answers in a new runtime, preserve pending
identity and props, and refuse repeated completed answers. Continue after reload
runs work once without rerunning prepare. Reject preserves the value, emits no
work update and restores no pending interaction again. [`indexeddb.test.ts`](indexeddb.test.ts)
adds zero-difference gate parity and close/reopen restore for both actions in
Chromium, with another reopen confirming completion. Each database is deleted.

The separate [`gates.ts`](cases/gates.ts) registry leaves `CASE_NAMES` at twelve;
the Python port covers those original twelve, not these additional JavaScript
cases. Existing goldens and matrices are unchanged. The fixtures use no model or
network. Gate-after-node topology and broader node-body child shapes remain
unmeasured. A gate's continue does not authorize writes: host confirmation
coverage and `approval: 'confirm'` still apply.

## Tutor portability, parent effects and credential scan

[`tutor-portability.node.test.ts`](tutor-portability.node.test.ts) covers AT-05 on Node. Both hosts declare the same workspace tutor package, alias its source entry and import its definition through the package. The test checks import specifiers and host graph construction, compares an in-memory SHA-256 entry digest and source inventory using the manifest builder's hash encoding, and checks local versus HTTP capability bindings. Vite bundles source, so the inventory covers source, package metadata and declared skills rather than the release manifest's `dist` files. Existing host loops separately execute the unchanged tutor with mocks; the optional combined runtime/node-set check is omitted because the remote host requires its browser/server harness.

[`subgraph-effects.test.ts`](subgraph-effects.test.ts) covers AT-35 separately from the twelve golden cases. A parent writes through the broker before invoking an interrupting child. On Node and Chromium, resume runs the parent body twice. With recovery and explicit node config, the full LangGraph task namespace gives both calls the same effect ID and the second call replays the successful receipt: one host write. Without recovery, host writes remain at two. [`task-scope.test.ts`](task-scope.test.ts) first verifies task identity across resume, graph reconstruction and IndexedDB reopen. [`subgraph-effect-scopes.test.ts`](subgraph-effect-scopes.test.ts) checks a fresh instance restoring the pending parent, ordinal-distinct calls in one task, a separately scoped child and later tasks of the same parent node. Chromium reopens IndexedDB; Node uses memory equivalents. Keep call order within a task deterministic and place effects outside the broker after interrupts or in separate completed nodes. See the [remaining limits](../../docs/unsupported.md#execution-and-langgraph).

[`credential-scan.test.ts`](credential-scan.test.ts) covers AT-23 on Node and Chromium. A real routed OpenAI-compatible provider uses injected fetch only, with a host callback supplying a generated canary. Two calls span a pending interaction; the second succeeds, returns 401 or throws a transport error. Both failure fixtures include the canary in their raw failure text. The canary appears in request Authorization headers and is absent from request bodies, every runtime event and observed snapshot, errors including non-enumerable message/stack fields, host diagnostics, development warnings, exported spans and generated tutor manifest/schemas. Chromium enumerates every database with `indexedDB.databases()`, every store and every key/record, decoding binary envelopes for the scan; it scans at the pause and after completion. Both lanes scan decoded checkpoints and recovery submissions; Node has no IndexedDB and uses memory storage. Positive controls check the scanner's error and byte handling.

The credential fixture uses native `nostream` and projects replies away so its events/state contain no model text; this is not SDK stream redaction. Host-only `DiagnosticEvent.error` may hold raw host exceptions on other paths and must never be forwarded to traces or public surfaces. The scan covers these fixtures and build exports, not arbitrary host code or session exports. Page code receives credentials; XSS or a malicious same-origin dependency can read them. None of these tests uses real inference, weights, the real WebLLM bundle or a real `LanguageModel` global. Goldens, cases and the compatibility matrix are unchanged.

## Unknown-outcome write reconciliation

[`reconcile.test.ts`](reconcile.test.ts) restores a held LangGraph write through the real adapter and broker on Node with memory storage and in Chromium with IndexedDB closed and reopened between runtimes. A mock backend keyed by effect ID lets the hook replay an `applied` result without invoking again, or run a `not-applied` write once under its original effect ID. An `unknown` answer stays blocked until a later reload finds the result; a throwing hook also leaves the receipt `outcome_unknown`. These tests use no network or real backend and do not establish whether a host's `not-applied` answer is final.

## ONNX provider through the router

[`transformers-provider.test.ts`](transformers-provider.test.ts) runs the ONNX provider on Node and headless Chromium with a fake runtime behind the real Worker host and an in-memory model store, so no model is downloaded and any network call fails the test. It covers consent for an uncached model (refusal fetches nothing), stored files with the wrong hash, output safety on a growing chunk, token reservations settled from actual usage, Worker failure without fallback, tool calls through an ADK agent (parsed blocks, malformed blocks failing `invalid`, block verdicts failing `denied`, the shared tool-call case table) and routed structured output with `repairAttempts`. It is evidence for the router contract and says nothing about real-model quality.

## MCP server profile

[`mcp.test.ts`](mcp.test.ts) exercises the broker and the loopback
[`reference server`](../../examples/mcp-server/src/index.ts) on Node and headless
Chromium. AT-33 covers protocol headers, re-initialization after a forgotten
session, principal isolation, sign-out and bad-Origin rejection. Separate
sampling and elicitation probes send unadvertised server requests on the tool-call
SSE stream; each receives `-32601` while the tool call completes.

`AT-33 rejects elicitation on the call SSE stream without exposing its prompt`
also checks that the client's initialization advertises neither sampling nor
elicitation. The probe text is absent from the agent result, MCP events, runtime
events, spans, diagnostics and snapshot. The shared fixture controls reach the
server directly on Node and through Vitest browser commands on Chromium. These
tests use mock tools and no model inference or external server; they add no
elicitation support and change no goldens or compatibility-matrix entries.

## HTTP tagging, auth and CORS

[`http-integration.test.ts`](http-integration.test.ts) exercises `httpCapability` through a real runtime, LangGraph adapter, broker and routed mock model. It covers AT-29's agent/run attribution on reads and tagged sensitive writes rejected with 403, including host header override/removal attempts. AT-16 covers a real 401 without a token and success with a host-supplied bearer token. Attribution is not authorization; backends still own authorization and custom bindings must forward attribution.

The existing conformance global setup starts two ephemeral `127.0.0.1` HTTP servers from [`support/http-fixture.node.ts`](support/http-fixture.node.ts) and provides `inject('http')`. Node tests create their own fixture. One server allows exactly the runner origin `http://127.0.0.1:63315` and the content-type, authorization and attribution headers; the other sends no CORS headers. Tests reset and read both servers' request records through the CORS server's admin route.

The two CORS cases run only in Chromium. A distinct item URL avoids a cached preflight in the success case. The failure case uses `credentials: 'omit'` and asserts that the no-CORS server received `OPTIONS` but no application request: the server was reachable and the browser blocked the call. The capability rejects and the run fails with fixed `unavailable`, which does not distinguish CORS from other network failures. Auth and sensitive-endpoint failures use fixed `denied`.

The tests inspect events, snapshots, spans and typed errors for response-body, credential and model-text canaries. Host-only `DiagnosticEvent.error` is inspected locally and excluded from public-field serialization. Native LangGraph's `nostream` tag suppresses mock message streaming, and replies stay out of graph state; this is fixture behavior, not SDK redaction. No real model, weights, third-party endpoint or Local Network Access prompt is used.

## Explicit config and context

Both galaxie lanes import only `/web`. During the first `prepare`, the adapter installs its synchronous context shim only if no global LangChain context instance exists. The following are observed at the pinned versions:

| API or context rule | Required usage under the shim | Proving test |
| --- | --- | --- |
| `requestInteraction(request, config)` after an `await` | Pass the node's `config`; the helper scopes stock `interrupt()` synchronously and preserves interrupt-ID resume | [`interaction-context.test.ts`](interaction-context.test.ts): `requestInteraction after await pauses and resumes through explicit config` |
| Stock `interrupt()` using implicit context | Implicit context is confined to the node's synchronous prefix. After an `await`, use `requestInteraction(request, config)` | [`interaction-context.test.ts`](interaction-context.test.ts): `stock interrupt after await fails with executor_error under the shim`; [`interaction.test.ts`](../../packages/adapter-langgraph/test/interaction.test.ts): `runWithConfig exposes the config under the synchronous shim` |
| An agent-held chat model using implicit config | Config propagation works in the synchronous prefix; pass config explicitly across asynchronous work | [`interaction-context.test.ts`](interaction-context.test.ts): `a model called without config in the synchronous prefix emits messages` |
| Routed `host.langchain.chatModel(role)` calls | Always pass the node's `config` for stream callbacks and model span parenting, including in the synchronous prefix. Routing still executes without config, but its asynchronous policy and credential work loses implicit callbacks | [`tracing.test.ts`](tracing.test.ts): `a model without forwarded config has a node span and no implicit model span`; the `model-without-config` entries in [`compatibility-matrix.json`](compatibility-matrix.json) |
| Node context installation | Initialize real `AsyncLocalStorage` before the first adapter `prepare` when other LangChain code needs async context. Installation is first-writer-wins; the adapter preserves an existing global instance | [`interaction.test.ts`](../../packages/adapter-langgraph/test/interaction.test.ts): `context installation preserves a pre-existing global instance` |

The table lists tested behavior rather than every LangChain context API. The adapter does not import Node context modules or replace an existing context instance.

## Native Python reference

[`cases-python/`](cases-python/) ports the original twelve graph cases to the pinned native
CPython 3.14 and LangGraph Python environment. Its modules expose `INPUT`, `SCRIPT`,
`RESUMES` and `factory(checkpointer, model, capability, interaction)`. The optional
ports default to deterministic local fixtures; the Pyodide harness injects galaxie's
checkpointer and interaction helper. Node names, request values, mock replies and
re-execution counters follow the JavaScript cases. The native reference remains independent of the Python executor.

[`golden-python/`](golden-python/) contains the independent CPython transcripts:
the four stream modes and paths, checkpoint history, pending interrupt IDs and
values, final state and fixed error types. Generated UUIDs and interrupt IDs are
normalized. Message projections retain only `type`, `content`, `id` and the
`langgraph_node`/`langgraph_checkpoint_ns` metadata subset. The Python goldens do
not change the JavaScript goldens or compatibility matrix.

`pnpm test:python` verifies these references, including the interrupting node's
re-execution and reconstructed-graph counters. Reconstruction shares an in-memory
saver inside CPython; it proves no browser reload or durable storage. The subgraph
counter after reconstruction is `{ callSub: 1, s1: 0, sask: 1 }`; the other reload
references have `{ prepare: 0, ask: 1 }`. Repeating a completed native resume emits
no node updates and preserves the completed state.

Regenerate intentionally with
`python/.venv/bin/python -I scripts/record-python-conformance.py`; run it with
`--check` to compare every encoded golden byte for byte without writing. The
recorder uses only the installed pinned environment and deterministic fixtures,
with framework tracing disabled. Review regenerated Python goldens as reference
changes.

The [Node Pyodide lane](pyodide.node.test.ts) and
[built Chromium harness](../../examples/rag-browser/test/python-conformance.node.test.ts)
run all twelve cases through the real Python adapter. The four original interrupt cases are: `interrupt-resume`,
`interrupt-sequence`, `interrupt-durability-sync` and `interrupt-durability-exit`.
They compare normalized pending IDs/values and final state/counters with the Python
goldens, check stable committed-state reads and reject an already answered resume.
The Chromium page rejects unknown case names with a fixed error and runs under the
unchanged RAG CSP and Trusted Types policy, blocking external requests. It reuses the
existing local wheel cache, skips when it is absent locally, and fails in CI if absent.
The same lanes also compare `linear` and `branching` stream projections, mode order,
paths and final output against the native Python goldens. Separate probes cover
checked model deltas, final usage, mid-stream output rejection, non-JSON and oversized
chunk rejection, and stream-free event replay. Only the allowed prefix reaches Python
after a block; later text never crosses the host-to-Worker bridge. Complete checkpoint
histories are not compared on these lanes. `subgraph` and `interrupt-subgraph` also
compare native stream paths, modes, output and pending values. `model-without-config`
uses the JavaScript mock provider through the router without an explicit node config;
`model-failure` maps to fixed `unavailable`, `capability` calls the JavaScript broker,
and `step-limit` matches the native 25-step stream before fixed `budget_exceeded`.
The [Python matrix](compatibility-matrix-python.json) records the text bridge's
message-ID difference and error mappings. The Chromium harness builds once and runs
separate tests with their own timeouts, at most two page loads per test and 39 overall.

The four reload cases (`interrupt-resume`, both durability cases and `interrupt-subgraph`) additionally
compare with native reconstruction references in `golden-python/reload/`. Node
reconstructs the runtime and Worker with a test byte store; the Chromium harness
disposes them, navigates to a fresh page, reopens IndexedDB and calls core
`instance.restore()`. The pending ID/value survives, completed nodes stay completed,
and final state/counters match the reference. The three original reload cases also reconcile an already
accepted answer and replay one host write across two parent executions around an
interrupting child. The subgraph reload restores `{ callSub: 1, s1: 0, sask: 1 }`.
A separate nested-write probe verifies distinct parent call ordinals and a full
three-part child task namespace; all three receipts replay on resume.
The Node lane checks checkpoint settlement writes after cancellation. Native
serializer tests check the actual twelve cases, RAG values and parent-effect fixture;
only documented exception-string and tuple-array decoding is allowed to differ.

## pydantic-ai conversations

The separate [pydantic-ai matrix](compatibility-matrix-pydantic-ai.json) lists 38
native-reference cases for model calls, tools, output validation, checked streaming
and deferred interactions. Native CPython, Node Pyodide and real headless Chromium
compare the same OpenAI-format requests, responses, capabilities, interactions and
stream projections. The CPython-only recorder uses the pinned OpenAI mapper;
provider SDKs do not enter the Worker wheel sets.

Seven native-output cases compare the routed schema constraint, validated output,
one permitted repair, a second repair refused by the route, run repair budget
exhaustion, the default route's repair refusal, checked text streaming and streamed repair.
The mock ignores the schema; these cases establish parity, not real-model constraint
enforcement. Existing goldens and reload variants remain unchanged.

Eight reload variants reuse those goldens: `approval-approve`, `approval-deny`,
`approval-mixed`, `call-deferred`, `approval-consecutive`, `stream-approval-approve`,
`approval-invalid-action` and `approval-incomplete`. Native runs serialize pinned
`ConversationTypeAdapter` bytes between fresh agents; Node reconstructs each
runtime and Worker; Chromium reloads the page and reopens IndexedDB. Restored
pending IDs are compared before normalization. Snapshots preserve messages, usage,
conversation identity, deferred requests, pause ordinals and effect positions.

Node and Chromium also exercise accepted-answer reconciliation, approved and
unapproved write receipt replay after Worker loss, changed-input refusal, corrupt
snapshot isolation and executor identity checks. Storage tests cover both closed-set
byte tags, exports, principal isolation, retention, logout and app-epoch fencing.
Fault probes preserve the committed pause after a failed checkpoint put and replace
orphan interrupt markers before completion. Snapshots cover pauses and completion;
there is no arbitrary mid-run replay or pydantic-ai subgraph support. Without the
byte-record port, pending state remains in Worker memory only.

Run the focused Node lane with
`pnpm exec vitest run --project node tests/conformance/pydantic-ai.node.test.ts tests/conformance/pydantic-ai-restore.node.test.ts`.
The built Chromium lane also runs the six delegation and child-approval cases below.
Its command is
`pnpm exec vitest run --project node examples/rag-browser/test/pydantic-ai-conformance.node.test.ts`.
`pnpm test:python` checks native transcripts and snapshot validation;
`uv run --locked --offline python -I ../scripts/record-pydantic-ai-conformance.py --check`
from `python/` reproduces the existing pydantic-ai goldens without writing them.

The maintained RAG example adds the third executor without changing the LangGraph
RAG golden. [Native agent tests](../../examples/rag-browser/agent_py/tests/test_pydantic_ai_agent.py)
and [Node Pyodide tests](../../examples/rag-browser/test/pydantic-ai-agent.node.test.ts)
cover capability retrieval, cited text output, deferred passage approval and resume
validation. The Node tests also exercise a prompted-output retry whose retry part
has no tool name, using the mock's opt-in assistant-turn sequencing.
[Built Chromium page tests](../../examples/rag-browser/test/loop.node.test.ts) cover
lazy selection, joined checked text deltas, selected-executor byte totals,
pending-review reload through reopened scoped IndexedDB, kept-passage resume,
Start over deletion, switching all four executors and an injected-passage output
block. The pydantic-ai review is an approval, with no subgraph path. Tests use mock
models only and retain the page/Worker CSP and Trusted Types policy. The
[documented mock command](../../examples/rag-browser/README.md#passage-review-with-mock-models)
serves all four executors. A mock-only hands-on Chrome check of DSPy (2026-10-31)
covered a cited answer, review with two kept passages, reload restore of the executor and pending review, resume and Start over.

## pydantic-ai agent delegation probes

The [CPython probes](cases-pydantic-ai-delegation/test_delegation_probes.py) and
[Node Pyodide probes](pydantic-ai-delegation.node.test.ts) now exercise the shipped
`galaxie.pydantic_ai.run_child` and nested-run guard with the same
[scripted replies](cases-pydantic-ai-delegation/fixtures.json). The original spike
outcome rule remains in the fixture docstring for comparison. The tables below
record the helper and guard behavior alongside the original probe-local hoist
pattern. The [shipped child approval hoist](#pydantic-ai-child-approval-hoist) has
its own conformance suite. A green characterization test can still pin a limit.

Versions: pydantic-ai-slim 2.60.0, pydantic-graph 2.60.0, CPython 3.14.5,
Pyodide 314.0.7, Node 24.15.0 and pnpm 11.21.0. Re-run these probes on every
pydantic-ai version bump, including public message and tool run-ID checks.

Variants: `plain` forwards nothing; `usage` forwards dependencies, usage and
limits; `conv` also reuses the parent's conversation ID. All three plain nested
forms are now refused. `helper` calls the shipped `run_child`. `id-control` uses
the spike's hash of parent conversation/tool-call IDs as a helper key, keeping
the control registered while making it sensitive to regenerated tool-call IDs.
All evidence below is scripted.

| Probe | Priority | CPython result | Node Pyodide result |
| --- | --- | --- | --- |
| D1 accounting | P0 | Not applicable | Helper: four model calls, two capability calls, 16 tokens and 16 fixture cost units. Exact-budget success and 15-token/15-cost/one-tool refusals establish shared accounting. |
| D2 parent step limit 3 | P0 | Helper: three requests then `budget_exceeded`. Plain/usage/conv: `unsupported` after one parent request, no child request or capability call. | Same. JavaScript does not independently enforce pydantic-ai steps. |
| D3 child private data | P0 | Not applicable | After one helper child read, `private-user` sticks; the next child request fails `denied` before reaching its third-party provider. Three bridge requests, two provider calls total. |
| D4 scope identity | P0 | Helper scopes are stable, distinct from the parent and unchanged when the delegate tool-call ID changes at the same position. The ID-sensitive control changes scope. | Not applicable |
| D5 mid-delegate write reload | P0 | Not applicable | After a crash following the child write, a changed scripted delegate ID preserves the helper's scope and effect ID: one write, one journal entry. The ID-sensitive control changes both IDs: two writes, two entries. |
| D6 native repair counter | P1 | Two sequential helper children begin at repair indices `[0, 0]` across five requests. | Both complete with route and run repair allowances of zero; bridge indices are `[0, 0]`. |
| D7 child streaming | P1 | Not applicable | Plain child streaming fails `unsupported` before child dispatch. The helper has no streaming variant. |
| D8 non-bridge child | P1 | A plain FunctionModel child remains invisible to the bridge: only two parent requests. The helper and `model=` override validation refuse that child with `unsupported` before transport. | Not applicable |
| P1 excluded deferred output | P0 | Native `UserError`, two requests, zero gated bodies. | Not applicable |
| P2 deferral returned as data | P0 | Three requests, zero gated bodies; parent completes without a host pause. | Same. |
| P3 probe-local hoisted approval | P0 | Probe-local metadata forwarding or `ToolApproved.override_args` resumes a helper child; five requests, writes 2 and 3 once each. Default resume loses child metadata. | Explicit metadata forwarding: one pause, five requests, writes 2 and 3 once each. |
| P4 probe-local hoist snapshot/reload | P0 | Not applicable | Identical restored pending interaction; writes 2 and 3 once each across fresh Workers. |
| P5 probe-local parallel pauses | P1 | The original pattern puts two delegate approvals in one parent interaction; three requests, zero gated bodies. The shipped hoist refuses this shape. | Not applicable |
| P6 probe-local answer/state validation | P1 | Explicit resume schema rejects extra answer fields, but outer restore accepts corrupt author metadata outside the reserved hoist entry. Native validation becomes parent retry data; parent completes without the gated write. | Not applicable |
| S1 child stream paths | P0 | [Stream tests](../../python/galaxie/tests/test_pydantic_ai_subgraphs.py) pin parent-only wire notifications for plain delegation and a hoisted pause; controls detect child text and paths. | D1 asserts empty parent stream paths and no child text. Routed child replies still pass output safety. Plain child streams are refused. |
| S2 capability flag | P1 | Not exposed by the Python Executor | Actual prepared adapter advertises `subgraphs: false`. |
| G1 public nested-run detection | P0 | Public message `run_id`, streamed `run_context` and tool `RunContext` distinguish registered work from plain nested runs. Top-level retries, resume, sequential runs and parallel tools pass. | Not applicable |
| G2 guard before bridge | P0 | `unsupported` before child model/capability requests, including an approved child capability before its next model request. | Nested ordinary/streaming model requests never reach the bridge; the restored approved plain child capability is refused before live work. |
| F1 flattened gate | P0 for the pause alternative | One pause, two model calls, one gated capability execution. | Identical restored pending interaction, one write overall. |

| Gap | Shipped outcome | Evidence and limits |
| --- | --- | --- |
| Delegation without child pauses | **Supported through `run_child`; plain nested runs refused** | Shared budgets, positional identity, per-child repairs and public-only refusal checks pass. Three new conformance cases match native CPython on Node Pyodide. |
| Child pause propagation | **Supported through `run_child(..., hoist_approvals=True)`** | The [new suite](#pydantic-ai-child-approval-hoist) covers approve, reject and restore with validated state and required child-call display. P3–P6 retain the original probe-local pattern as comparison evidence. |
| Subgraphs flag and stream paths | **Refused** | Probe S1 is pinned by the Python wire tests, the adapter driver empty-path tripwire and Node D1 stream assertions. No child stream paths exist; `subgraphs` remains false, including on prepared delegating adapters in Chromium. |

The separate [delegation matrix](compatibility-matrix-pydantic-ai-delegation.json)
and [native suite](cases-pydantic-ai-delegation-suite/delegation_native.py) add
three new goldens: `delegation-reload-write` (five model requests, one child write,
final `parent-done`), `delegation-shared-budgets` (three requests then
`budget_exceeded`) and `delegation-nested-plain-refused` (one parent request,
`unsupported`, no capability call). Native reload also serializes and restores the
parent conversation before approval. The native budget reference shares usage
independently; the native refusal reference encodes the adapter's expected limit.
Crash-after-write replay, exact effect IDs, journal sizes, token/cost/tool-call
budgets and native repair indices are Node-only assertions, outside the goldens.

### Where native behavior cannot be matched

Without `hoist_approvals=True`, a child's `DeferredToolRequests` remains tool
data; excluding it from the child output types retains the native `UserError`.
Neither form publishes a child host interaction by itself. With the flag, the
helper requires a known output type containing `DeferredToolRequests` and the
executor preserves the reserved child state through approval and reload. Several
hoisted children, several child approvals, external child calls and nested hoists
remain refused under the single-pending-interaction contract. Unrelated author
metadata, including the original probe-local hoist metadata, stays unvalidated.
Snapshot bytes are not authenticated.

Plain non-`GalaxieModel` children and direct trusted `capabilities.call` can bypass
the guard. The helper refuses a child whose selected model is not a `GalaxieModel`,
including a non-`GalaxieModel` `model=` override. SDK-controlled budgets and label checks cover bridged calls, not
arbitrary trusted Python code. The guard is accident-proofing, not an isolation
boundary; ADR-0012 controls remain in JavaScript. Direct model/helper use outside
an `Executor` has no active-run guard.

Unit tests also cover non-bridge models selected through agent overrides,
capabilities and request hooks; implicit child streaming from handlers and
capabilities; background delegation after parent completion, failure or
cancellation; and cancellation cleanup of an in-flight child. These paths are
checked before new bridge traffic. Cleanup preserves child cancellation, and
parent exit revokes inherited run IDs.

### Author guidance

Import `run_child` from `galaxie.pydantic_ai` and await it from a tool with that
tool's `RunContext`. It returns the child's `AgentRunResult`, defaults dependencies
to `ctx.deps` and shares usage and limits. An explicit `deps` override is allowed.
Child identity hashes a domain tag, parent conversation ID, message position,
part index and `key`, excluding the provider's tool-call ID. Preserve deterministic
call order and structure on replay; use distinct keys for several children in one
tool body. Duplicate identity within one executor run fails `invalid`.

The helper reserves `usage`, `usage_limits`, `conversation_id`, `run_id`,
`infer_name` and `metadata`; supplying any fails `invalid`. It retains existing
instrumentation, native-tool and model-setting refusals. Each child starts a fresh
native repair counter, leaving the parent and siblings unchanged. A permitted
retry still consumes the route and shared run repair budgets.

The guard checks public run IDs at model and capability boundaries and refuses a
nested `Executor.run`. A non-streamed request is authorized by the
capability of the run that makes it; message-history `run_id` stamps are not trusted,
so a prompt-less nested run that inherits the parent's history fails `unsupported`
(regression test `test_prompt_less_nested_run_inheriting_parent_history_is_refused_before_transport`).
Normal retries, resume and parallel tools pass the measured
checks. Writes still require host confirmation and matching scoped checkpoint and
recovery stores. For gated child workflows, use `hoist_approvals=True` and include
the calls from `hoisted_child_requests` in interaction props as described below.
Use only one hoisting child over the tool body's whole execution, as its first
child. A second is refused before its own work; an earlier approved child may
already have written when that second call is reached after resume.

The changed-ID probe measures sensitivity to a scripted regenerated ID. It does
not establish whether a real provider regenerates IDs. The helper preserves its
child scope and effect ID in that probe; the registered ID-sensitive control
repeats the write. No JavaScript runtime or bridge protocol change was required, and the
JavaScript entry size budget covers neither the adapter nor the Python wheel.

### Chromium results

The existing built Chromium fixture runs the six shipped cases against their
unchanged CPython goldens. The two reload cases reopen the scoped IndexedDB saver
and recovery store after a real page reload, preserve the pending interaction and
write exactly once.

| Case | Page loads | Writes per load | Final effect count | Equal to golden | Differences from Node |
| --- | --- | --- | --- | --- | --- |
| `delegation-reload-write` | 2 | `[0, 1]` | 1 | Yes | None |
| `delegation-shared-budgets` | 1 | `[0]` | 0 | Yes | None |
| `delegation-nested-plain-refused` | 1 | `[0]` | 0 | Yes | None |
| `child-approval-approve` | 1 | `[1]` | 1 | Yes | None |
| `child-approval-reject` | 1 | `[0]` | 0 | Yes | None |
| `child-approval-restore` | 2 | `[0, 1]` | 1 | Yes | None |

These cases add eight Worker lifetimes using the same page fixture, Vite build,
preview server and browser as the conversation cases. Each test has an explicit
900000 ms timeout, with a 600000 ms page wait. Assertions cover one Worker created
and terminated per load, observed Worker errors, empty stream paths, the prepared
`subgraphs: false` flag, model roles, child effect scopes and durable effect counts.
The unchanged strict CSP header is checked on every response, CSP violations are
observed and external requests are blocked and recorded.

### Not measured

- Firefox and WebKit: these tests run in the `node` project, outside the CI jobs
  that run the `browser` project on those engines.
- Real providers, actual provider ID regeneration, Worker network reachability,
  latency, cost or device performance. Fixture cost units test accounting only.
- Arbitrary mid-run continuation without an earlier committed parent pause,
  general nested graphs, deeper delegation trees and scheduler interleavings.
- The prepared flag in CPython: it belongs to the JavaScript adapter and is measured
  in Node and Chromium instead.

Reproduce without rewriting existing goldens:

```sh
node scripts/test-python.ts ../tests/conformance/cases-pydantic-ai-delegation
node scripts/test-python.ts ../tests/conformance/cases-pydantic-ai-delegation-suite
node scripts/test-python.ts ../tests/conformance/cases-pydantic-ai-child-approval
node scripts/test-python.ts galaxie/tests/test_pydantic_ai_child_approval.py
node scripts/test-python.ts galaxie/tests/test_pydantic_ai_subgraphs.py
# Rebuild after Python library edits before running Node Pyodide.
node scripts/build-python-wheels.ts
pnpm exec vitest run --project node tests/conformance/pydantic-ai-child-approval-conformance.node.test.ts tests/conformance/pydantic-ai-delegation.node.test.ts tests/conformance/pydantic-ai-delegation-conformance.node.test.ts tests/conformance/pydantic-ai.node.test.ts tests/conformance/pydantic-ai-restore.node.test.ts
pnpm exec vitest run --project node examples/rag-browser/test/pydantic-ai-conformance.node.test.ts
# From python/:
uv run --locked --offline python -I ../scripts/record-pydantic-ai-delegation-conformance.py --check
uv run --locked --offline python -I ../scripts/record-pydantic-ai-child-approval-conformance.py --check
uv run --locked --offline python -I ../scripts/record-pydantic-ai-conformance.py --check
```

Existing goldens, matrices, locks and core contracts remain unchanged. Separate
delegation and child approval suites add their own goldens and matrices. Both
recorders' `--check` modes reject an edited golden; restoring its original bytes
returns the check to green.

## pydantic-ai child approval hoist

`run_child(..., hoist_approvals=True)` now carries a child's gated call through the
parent's one pending interaction. The [shared suite](cases-pydantic-ai-child-approval/child_approval_suite.py)
uses the same scripted replies for the [independent native reference](cases-pydantic-ai-child-approval/child_approval_native.py)
and [Node Pyodide lane](pydantic-ai-child-approval-conformance.node.test.ts).
The [matrix](compatibility-matrix-pydantic-ai-child-approval.json) records these
three new goldens; the original delegation probes and evidence remain unchanged.

| Case | Model requests | Capability writes | Result |
| --- | --- | --- | --- |
| `child-approval-approve` | 4 | 1 | One parent interaction includes the child's `save` call; approval finishes with `parent-done`. |
| `child-approval-reject` | 3 | 0 | Denial abandons the child and gives the parent the standard denial; output is `parent-done`. |
| `child-approval-restore` | 4 | 1 | A fresh Worker restores the identical interaction; the write happens only in the second lifetime and output is `parent-done`. |

Each case has one interaction. The native hoist independently serializes and
resumes public pydantic-ai conversations; it does not call the galaxie helper.
The native reload variant also reconstructs the parent agent and checks its
restored interaction. Node checks the parent/child request order, child effect
scope, one write journal entry for approve/restore and none for rejection,
`subgraphs: false`, and no Worker errors. One fixture shares its server, sources
and bundle across all cases: approve and reject use one Worker each, restore uses
two. Tests and fixture hooks carry explicit 900,000 ms timeouts; no extra Worker
is started for these assertions.

The executor owns `galaxie.child-approval` metadata. The
[Python unit tests](../../python/galaxie/tests/test_pydantic_ai_child_approval.py)
exercise the validation boundaries and refusal paths:

| Check | Evidence |
| --- | --- |
| Entry and conversation shape | Missing/extra fields, version, bounded key, hexadecimal identity, JSON projection, 128 KiB UTF-8 state bound and matching conversation ID. |
| Child pending call | Exactly one approval, no external calls, bounded unique IDs, metadata confined to pending IDs and matching calls in the last response. Duplicate response IDs, nested hoist metadata and invalid trailing messages are refused. A plain sibling's return is preserved without replay. |
| Delegate binding | The child identity matches the parent conversation, message position, part and key; re-entry also compares the code-side key. A foreign valid pause is refused. |
| Display binding | One object under interaction props must contain the child's `id`, `name` and matching `arguments` together. Missing, scattered or changed fields and changed restored arguments are refused. |
| Callback control | Dropped, replaced or mutated callback state cannot replace the validated entry. Denial drops child state without re-entry; unrelated author metadata remains author-owned. |

Publish validation fails fixed `unsupported` before an interaction is pending;
restore validation fails fixed `unrecoverable`; re-entry misuse fails fixed
`invalid` before the gated body. No child content appears in these errors.
Tests also pin registration of the fresh resumed child, refusal of unregistered
resumes and borrowed history stamps, shared usage and step limits, parent
streaming, and equal effect scopes when replaying the same snapshot twice.
Sequential child approvals produce distinct interaction IDs. If the delegate tool
itself requires approval, its own gate precedes the child's gate, with no child
write until both approvals have been answered.

The shipped hoist refuses two parallel delegate pauses, several child approvals,
external child calls, nested hoists and oversize state. Only one hoisting child
may run per tool body over its whole execution. A second fails before its own
request or write; the first approved child may already have written when code
reaches the second after resume. This keeps the existing one-interaction contract;
[ADR-0030](../../docs/adr/0030-several-engine-pauses-published-one-at-a-time.md)
remains Proposed. Put the hoisting child first, because earlier children can
replay when the tool re-enters.

**Measured browser scope.** Approve, reject and restore match their goldens in
headless Chromium with scripted models (see [Chromium results](#chromium-results)).
Firefox, WebKit, real providers, child stream paths and general nested checkpoints
remain unmeasured. A Node crash-after-write replay of the hoisted resume remains
unmeasured; CPython proves
scope equality across attempts, and the existing D5 probe measures broker receipt
replay for the same scope construction. Snapshot bytes are not authenticated, so
checkpoint-store writers can forge parent and child state. Unrelated author
metadata remains unvalidated. The 128 KiB child-state bound does not remove the
1 MiB bound on the encoded parent checkpoint and display frames; an oversized
checkpoint frame is refused before transport.

## pydantic-ai native tool refusal probes

The [CPython probes](../../python/galaxie/tests/test_pydantic_ai_native_tools.py),
[Node Pyodide probes](pydantic-ai-native-tools.node.test.ts) and
[bridge probes](../../packages/adapter-pyodide/test/bridge-native-tools.test.ts)
pin scripted observations separately from their outcome. The rule and probe
criteria were committed before any run. Versions: pydantic-ai-slim 2.60.0,
pydantic-graph 2.60.0, CPython 3.14.5, Pyodide 314.0.7, Node 24.15.0 and pnpm
11.21.0. A version bump reopens the question; the kind registry is pinned by name.

A cell is one static kind, dynamic/per-run tools, or response parts. Support
requires provider execution, a bridge declaration/result channel, a router feature
and broker grant/label/budget/confirmation proof. An alternative requires failed
support, a retrieval kind and satisfied N4. Otherwise fixed refusal before any
model/capability/interaction request establishes refusal. A P0 bypass is unsafe as
shipped; unmeasured P0 makes its cell undetermined. The rule reads only satisfied
results; green characterization assertions can pin a not-satisfied condition.

| Probe | CPython result | Node Pyodide result | Bridge result |
| --- | --- | --- | --- |
| N1 static tools, both prepare entries | Satisfied for all ten kinds after the prepare check | Satisfied for static kinds after the prepare check | Not applicable |
| N2 request backstop, each kind | Satisfied: fixed `unsupported`, zero requests | Satisfied: fixed `unsupported`, zero model/capability/interaction requests | Not applicable |
| N3 adaptive native capabilities | Satisfied: WebSearch, WebFetch, ImageGeneration, XSearch and explicit native-only MCP refuse at prepare | Not applicable | Not applicable |
| N4 retrieval equivalence and one-request criterion | **Not satisfied:** equal transcripts, two model requests and one capability request | **Not satisfied:** equal raw/normalized traffic, two model requests and one capability request | Not applicable |
| N5 native-default local search (informational) | Satisfied: refuses at prepare; `native=False` is required | Not applicable | Not applicable |
| N6 ordinary agents | Satisfied: baseline, function and capability tools prepare and complete | Satisfied: baseline, function and capability tools prepare and complete | Not applicable |
| N7 deferred loading (informational) | Satisfied: prepare accepts, first request refuses with zero traffic | Not applicable | Not applicable |
| D1 native factories | Satisfied after the prepare check: tool/None factories refuse without invocation | Satisfied after the prepare check: tool/None factories refuse before model work | Not applicable |
| D2 agent override | Satisfied: fixed `unsupported`, zero traffic | Not applicable | Not applicable |
| D3 direct native requests | Satisfied: ordinary/streamed and required/optional tools refuse before transport | Not applicable | Not applicable |
| D4 first/resumed run keywords (informational) | Satisfied: no `capabilities` option | Not applicable | Not applicable |
| RP1 four native history parts | Satisfied: fixed `unsupported`, zero traffic | Not applicable | Not applicable |
| RP2 malformed native reply shapes | Satisfied: all three fail fixed `invalid` | Not applicable | Not applicable |
| B1 native declaration shapes | Not applicable | Not applicable | Satisfied: both unknown options and non-function declaration fail fixed `invalid` |
| B2 native response parts | Not applicable | Not applicable | Satisfied: extra response key fails fixed `invalid` |
| RP3 array provider reply | Not applicable | Satisfied: model called once, zero capabilities, fixed `unsupported`, no successful Python model reply | Not applicable |
| RP4 internal provider execution with text only (informational) | Not applicable | Unmeasured; reasoned below | Not applicable |

N1 first observed acceptance at both preparation entries for nine static kinds,
then fixed refusal at the first request with zero traffic. A factory returning a
native tool behaved the same; a factory returning `None` completed one ordinary
model request. That characterization was committed before adding the prepare
check. The check ignores only optional `tool_search`, which ordinary agents carry,
and refuses other static tools and all factories without executing them. Preparing
an already-created executor revalidates capabilities added afterwards.

Required `tool_search` conflicts with pydantic-ai's automatic optional declaration
during `Agent` construction. The probes pin that upstream `UserError` separately
(Node Worker boot reports fixed `unavailable` for this construction failure);
a public `root_capability.capabilities` mutation adds the required form to a clean
agent and proves the executor's prepare refusal. Before the check, that mutation
prepared and then failed fixed `executor_error` with zero model/capability traffic
because the run encountered the duplicate declarations. Direct requests prove its model
backstop. `MCP` defaults to `native=False`; N3 explicitly uses
`MCP(native=True, local=False, url=..., id=...)` with inert values, avoiding the
optional local client. These are observed constructor differences, not skipped
native kinds.

N4's ordinary capability tool and `WebSearch(native=False, local=<same tool>)`
produce equal final answers and model payloads, one function declaration per
request, one capability call, and a scope matching
`pydantic-ai/<conversation>/<n>/<n>`. CPython uses no extra request options beyond
`tools` and `toolChoice`; Node additionally uses checked `stream`. Both need a tool
response followed by a final model answer: **two model requests**. The fixed
criterion says exactly one, so N4 is not satisfied and no retrieval cell earns an
alternative outcome. Authors can still use the measured ordinary/local capability
form for retrieval; this is not provider-tool parity. The plain form also expresses
file retrieval through a host-bound capability.

| Cell | Outcome | Deciding probes |
| --- | --- | --- |
| Static `advisor` | Refused | N1/N2; support conditions absent |
| Static `code_execution` | Refused | N1/N2; no generic code capability |
| Static `file_search` | Refused | N1/N2; N4 not satisfied |
| Static `image_generation` | Refused | N1/N2/N3; no image result channel |
| Static `mcp_server` | Refused | N1/N2/N3; N4 not satisfied |
| Static `memory` | Refused | N1/N2; provider-held state |
| Static `tool_search` | Refused | N1/N2, informational N7; no native loading channel |
| Static `web_fetch` | Refused | N1/N2/N3; N4 not satisfied |
| Static `web_search` | Refused | N1/N2/N3; N4 not satisfied |
| Static `x_search` | Refused | N1/N2/N3; N4 not satisfied |
| Dynamic and per-run native tools | Refused | D1/D2/D3; D4 informational |
| Provider-native response parts | Refused | RP1/RP2/B1/B2/RP3; RP4 informational |

The four support conditions are not established:

- S1: no native-tool execution is declared in the repository providers.
  [OpenAI-compatible declarations and replies](../../packages/models/src/openai/chat-model.ts)
  require function tools and string content;
  [WebLLM](../../packages/models/src/webllm/chat-model.ts),
  [Built-in AI](../../packages/models/src/builtin-ai/chat-model.ts) and
  [Transformers](../../packages/models/src/transformers/chat-model.ts) have no native
  provider-tool execution path.
- S2: B1/B2 reject declarations and results in the
  [closed bridge](../../packages/adapter-pyodide/src/bridge.ts).
- S3: [ModelFeature](../../packages/core/src/models.ts) contains only streaming,
  structured-output, tool-calling and cancellation, with no native-tool label.
- S4: no provider-side use through broker grants, labels, budgets and confirmation
  was observed; the native request path refused before dispatch.

**Where native behavior cannot be matched.** Provider-side execution carries no
broker effect identity or per-tool grant, label, budget or confirmation path.
Provider-held memory and advisor calls are outside the router. ADR-0012 forbids a
generic code capability, and the bridge has no image result channel.
`MCP(local=True)` and `WebSearch(local='duckduckgo')` could open Worker network
access; neither was run. The MCP fallback also needs the absent optional
`fastmcp` package. Use host-bound capabilities to keep retrieval data under broker
labels and destination policy. A host-registered provider that executes native
tools internally and returns only text is invisible to this adapter; the host
takes on those controls under ADR-0012's SDK-controlled-path limit. That conclusion
is reasoned, not a measurement.

**Not measured.** Native-tool Chromium probes, real providers, actual native tool
execution, network reachability, the optional MCP/DuckDuckGo fallbacks and
string-only replies after internal provider execution. All applicable P0 native
probe shapes ran on their declared lanes; no wheel-dependent lane was skipped.
No golden, matrix, existing case, lock or JavaScript package source changed.

```sh
node scripts/test-python.ts galaxie/tests/test_pydantic_ai_native_tools.py
pnpm exec vitest run --project node tests/conformance/pydantic-ai-native-tools.node.test.ts
pnpm exec vitest run --project node packages/adapter-pyodide/test/bridge-native-tools.test.ts
```

## DSPy custom engines and replay

The separate [DSPy matrix](compatibility-matrix-dspy.json) lists 48 scripted
cases against pinned DSPy 3.4.1. The [native recorder](../../scripts/record-dspy-conformance.py)
checks 38 independent CPython goldens using DSPy's own
`lm15_boundary.request_kwargs`; the durable cases use separate driver and host
restore probes, including native driver tests. Provider SDKs never enter the Worker. Predict, ChainOfThought, ChatAdapter,
non-streaming JSONAdapter, ReAct, ReActV2 and native/text-parsed tools compare
requests, results, fixed errors and declared field streams across CPython, Node
Pyodide and headless Chromium. Existing goldens and matrices remain unchanged.

The executor declares streaming, interrupts, resume and checkpoints true, subgraphs
false. Pauses unwind the whole program and resume against a canonical-request
journal. Authors must keep execution deterministic apart from model, capability
and interaction calls. Replay emits one content-free count, no field text or live
model calls; divergence fails `unrecoverable` before later live calls. Reload/fault
probes cover accepted-answer reconciliation, write receipts, corrupted/versioned
records, exports, logout and app-epoch fencing. Restored input and journal results
register private strings through core's framework-neutral `registerRestoredData`
hook before restored URL validation or any live outbound call. Pauses fit the
1 MiB bridge envelope; completion stores compact counters without personal input
or journal data. Work beyond the last committed pause may run again after loss.

An `Executor` with `stream_fields` always streams and needs a provider declaring
streaming. Fields must identify exactly one predictor's plain-`str` output.
Streaming ReActV2 requires `next_thought` annotated as `str`. A field header
indented on its line is not streamed; final ChatAdapter parsing still returns its
value. JSONAdapter streaming and ChatAdapter JSON fallback are unsupported.
Ordinary ReAct author tool exceptions become observations with a five-frame
traceback, including paths/source lines, sent in the next routed model request.
Galaxie failures instead terminate before that call with fixed codes.

Focused commands from the repository root:

```sh
pnpm exec vitest run --project node tests/conformance/dspy.node.test.ts tests/conformance/dspy-restore.node.test.ts
pnpm exec vitest run --project node examples/rag-browser/test/dspy-conformance.node.test.ts
python/.venv/bin/python -I scripts/record-dspy-conformance.py --check
```

Offline-optimized state has a separate seven-case family and new goldens;
it does not extend the existing DSPy matrix. Native scripted `LabeledFewShot`,
scripted-LM `BootstrapFewShot`, multi-predictor ReAct demos and an instructions-only
stand-in compare CPython, Node Pyodide and Chromium transcripts. Refusal tests
cover loaded LMs, pickle sources and both size bounds. The executable catalog
records round-trip losses; the opt-in Node probe measures size and load cost
without timing thresholds. See the [results and limits](../../packages/adapter-pyodide/README.md#offline-optimized-program-state).

Eight separate paused-session scenarios swap unchanged, prompt-changing or
saved-training-only state in fresh Workers on CPython, Node Pyodide and Chromium
with a page reload through IndexedDB; they add no goldens or matrix entries.
They verify journal-dependent refusal, accepted swaps with no changed journaled
request, persistent poisoning after refusal and the author-side SHA-256 interaction
props recipe; see [observed outcomes](../../packages/adapter-pyodide/README.md#paused-sessions-and-a-changed-state-file).

```sh
node scripts/test-python.ts ../tests/conformance/cases-dspy/test_dspy_state.py
node scripts/test-python.ts ../tests/conformance/cases-dspy/test_dspy_state_durable.py
python/.venv/bin/python -I scripts/record-dspy-state-conformance.py --check
pnpm exec vitest run --project node tests/conformance/dspy-state.node.test.ts
pnpm exec vitest run --project node tests/conformance/dspy-state-restore.node.test.ts
pnpm exec vitest run --project node tests/conformance/dspy-state-limits.node.test.ts
pnpm exec vitest run --project node examples/rag-browser/test/dspy-state-conformance.node.test.ts
GALAXIE_DSPY_STATE_MEASURE=1 pnpm exec vitest run --project node tests/conformance/dspy-state-limits.node.test.ts --silent=false --reporter=verbose
```

`pnpm test:python` also checks native transcripts and journal validation. All lanes
use pinned local wheels, synthetic replies and blocked external requests, with
unchanged CSP and Trusted Types. The maintained RAG tests add input-owned search,
review before any model sees passage text, kept-only citations, checked answer
streams, selected-executor byte totals, reload/resume and Start over. They extend
the [page loop](../../examples/rag-browser/test/loop.node.test.ts) and add
[CPython](../../examples/rag-browser/agent_py/tests/test_dspy_agent.py) and
[Node Pyodide](../../examples/rag-browser/test/dspy-agent.node.test.ts) checks;
real-model format reliability, hands-on review and device performance are unmeasured.

## Google ADK conversations

The separate [ADK matrix](compatibility-matrix-adk.json) lists twelve cases for the `adk-js`
adapter: plain text, one and two sequential capability tool calls, an output schema with an output
key, a capability denial, an output-safety block on a function-call argument, the step budget,
abort, two streaming cases (text only, and a tool turn) and two approval cases (a confirmation
that is approved, and one that is denied). The reference is the pinned ADK 2.3.0 web bundle driven by its own `Runner` with a scripted
`BaseLlm` ([native lane](adk-native.node.test.ts), which writes the `golden-adk` files). The
[galaxie lane](adk.test.ts) runs the same agent through the adapter, router and broker on Node and
in headless Chromium and compares ADK-side requests, responses, capability calls, output and error
code. Call IDs are runtime-generated and are not compared. The streaming cases also compare the
text deltas and the content-free tool step markers; the other cases compare complete responses
only. The approval cases pause the native run, resume it with a second invocation carrying the
confirmation function response, and compare the paused tool calls, the model requests after the
resume and the output with the galaxie run answered through core's dispatch. It runs under the vitest browser project, not a page with the
strict mock CSP; the bundle-level strict-CSP probe lives in `packages/adapter-adk`. No other
executor's goldens or matrix change.

[adk-restore.test.ts](adk-restore.test.ts) covers durable sessions across two runtime lifetimes: a
pause that survives a reload and resumes to completion with the model seeing the restored history, a
write approved before a crash that replays its receipt after the restore, a failed run that stores
nothing, a record from another executor, and (Node) a tampered stored call, a record spliced from
another session and a corrupt record. Node keeps the byte records in memory; the Chromium lane uses
a real `IndexedDBSaver` and also checks that an export never contains the integrity key.
Confirmation and long-running reloads preserve the interaction ID without model or capability
work at restore. A changed tree whose paused author is no longer admitted fails `unrecoverable`
before publication; Node also checks repeated workflow-state rejection, unchanged stored rows
and another session's readability. The codec rejects any defined `actions.agentState` or
`actions.endOfAgent` on write (`unsupported`) and read (`unrecoverable`), with or without a pause.
These scripted Node/Chromium checks leave the record format unchanged; Firefox, WebKit and
real models remain unmeasured for them.

Agent shapes (`SequentialAgent`, `LoopAgent`, `ParallelAgent`, transfer) are compared with native ADK in [agents.test.ts](../../packages/adapter-adk/test/agents.test.ts), which also covers parallel write branches re-dispatched with reversed arrival and the refused pauses; the first-child pause reload is in `adk-restore.test.ts`.

Run it with `pnpm exec vitest run tests/conformance/adk.test.ts tests/conformance/adk-native.node.test.ts`. To rewrite the goldens on purpose, set `ADK_UPDATE_GOLDEN=1` for the native test, run `pnpm format` and review the diff.

## Google ADK Python conversations

The separate [ADK Python matrix](compatibility-matrix-adk-python.json) lists 39 scripted cases for
the `adk-python` executor against pinned `google-adk` 2.12.0 in the Pyodide Worker: text, tools,
denials, streaming, confirmations, long-running tools, durable restore, and the agent shapes
`agents-sequential`, `stream-agents-sequential`, `agents-parallel`, `agents-loop`,
`agents-transfer`, `agents-confirm-last`, `agents-confirm-first`, `agents-confirm-middle`,
`agents-confirm-nested`, `agents-confirm-parallel`, `agents-confirm-parallel-reversed` and
`agents-long-running-middle`. The six new workflow-pause cases enable native ADK resumability;
existing cases keep their original runner and golden bytes. The references are native CPython runs of ADK's own
`Runner` (`cases-adk-python/`, written to `golden-adk-python/` by
[`scripts/record-adk-python-conformance.py`](../../scripts/record-adk-python-conformance.py);
add `--check` to verify them). The [Worker lane](adk-python.node.test.ts) runs the same agents
through the adapter, router and broker on Node, the [restore lane](adk-python-restore.node.test.ts)
reloads fresh Workers over one store, and the
[Chromium lane](../../examples/rag-browser/test/adk-python-conformance.node.test.ts) runs a subset
under the strict CSP and Trusted Types. Shape cases script each model by agent name (the name in
ADK's system instruction). The unordered Parallel cases number tool-call IDs once per agent,
check raw call-ID consistency across each agent's requests, and assert fixture-declared
happens-before constraints against the arrival trace before sorting concurrent transcripts.
Both native and Worker lanes check the reply-gate order and that the merger follows both
branches; reload joins traces across runtime lifetimes. `afterCall` waits for another agent's
tool call so the reversed-order fixture can proceed before approval. Existing goldens are
byte-identical.

The six `confirm-beside-*` cases add a confirmation beside an ordinary call in both orders
and between two ordinary siblings, each approved and denied. Native ADK records every result;
live and restored Node Workers match those new goldens. Existing matrix entries and goldens
are unchanged. CPython measurements in `cases-adk-python/test_adk_python_confirmation_beside_calls.py`
and `python/galaxie/tests/test_adk_beside_calls.py` also cover native combined/split long-running
answers, sibling writes with fake host receipts, partial/wrong-kind answers and the validating
input replacement. Those measurements do not claim core broker integration or new Chromium
coverage. The [shared spike record](../../docs/adr/0020-google-adk-through-an-adapter.md#confirmation-beside-calls-and-request-input-spike-2026-11)
records each gate and the JavaScript Node/Chromium refusals. Native golden verification always
uses `python -I ../scripts/record-adk-python-conformance.py --check` from `python/`.

[`adk-python-agents.node.test.ts`](adk-python-agents.node.test.ts) asserts that `Workflow`,
`AgentTool` and the pause shapes ADK cannot resume faithfully fail `unsupported` at prepare, with
their non-resumable native results recorded in `cases-adk-python/test_adk_python_refused_shapes.py`.
`cases-adk-python/test_adk_python_resumable_shapes.py` compares resumed and uninterrupted model/tool
counts and records why Loop pauses and two confirming Parallel branches remain refused.
The agents lane proves write-receipt replay after reload in a sequence and both Parallel arrival
orders, after a failed resume with automatic recovery of the accepted answer, and when two
parallel write branches are re-dispatched in the opposite order. The six new pause goldens also
reproduce across fresh Workers in the restore lane. The Chromium subset is unchanged.
[`adk-python-scan.node.test.ts`](adk-python-scan.node.test.ts) scans the Worker
traffic, events, snapshots, diagnostics, spans, checkpoints and recovery journal for a per-call
credential through success, 401 and transport failure. All lanes use scripted models and injected
fetch; no real model, device measurement or third-party endpoint is involved.

```sh
pnpm exec vitest run --project node tests/conformance/adk-python.node.test.ts tests/conformance/adk-python-restore.node.test.ts tests/conformance/adk-python-agents.node.test.ts tests/conformance/adk-python-scan.node.test.ts
pnpm exec vitest run --project node examples/rag-browser/test/adk-python-conformance.node.test.ts
```

## Google ADK Go conversations

The separate [ADK Go matrix](compatibility-matrix-adk-go.json) lists the scripted cases for the
`adk-go` executor against pinned `google.golang.org/adk` v1.9.0 compiled to WebAssembly: text, tools,
denials, streaming, confirmations, long-running tools, durable restore, and the agent shapes
`sequential`, `bounded-loop`, `exit-loop`, `parallel`, `transfer` and `confirm-transfer`. The references
are native Go runs of ADK's own runner against a scripted page (`go/conformance`, written to
`golden-adk-go/` with `GALAXIE_RECORD_ADK_GO=1 go test -count=1 ./conformance/` from `go/`, then
`pnpm exec biome format --write tests/conformance/golden-adk-go`). The [Node lane](adk-go.node.test.ts)
runs the same agents compiled into the reference module through the adapter, router and broker, the
[restore lane](adk-go-restore.node.test.ts) reloads a fresh Worker at every pause over one store, and the
[Chromium lane](../../examples/rag-browser/test/adk-go-reference.node.test.ts) runs every case under the
strict CSP and Trusted Types. A case marked `unordered` (`parallel`) compares its wire lists by canonical
JSON text because sibling branches reach the page in any order. The matrix also records the refused
shapes.

[`adk-go-agents.node.test.ts`](adk-go-agents.node.test.ts) asserts that Parallel write branches keep
branch-local effect scopes whichever branch reaches the broker first and that a restore after the pause
that follows a Parallel stage runs no branch write again; `go/galaxie/shapes_test.go` asserts that
`agenttool`, agents and tools built directly with ADK, and toolsets fail `unsupported` before anything runs.
[`adk-go-run.node.test.ts`](adk-go-run.node.test.ts) covers raising models, budgets, abort, a panic,
`os.Exit` and a loop that ignores its context, and [`adk-go-scan.node.test.ts`](adk-go-scan.node.test.ts)
scans the Worker traffic, events, snapshots and spans for a per-call credential. All lanes use scripted
models; no real model, device measurement or third-party endpoint is involved. Go is required; the tests
skip with a fixed message when it is absent.

```sh
pnpm exec vitest run --project node tests/conformance/adk-go.node.test.ts tests/conformance/adk-go-restore.node.test.ts tests/conformance/adk-go-agents.node.test.ts tests/conformance/adk-go-run.node.test.ts tests/conformance/adk-go-scan.node.test.ts
pnpm exec vitest run --project node examples/rag-browser/test/adk-go-reference.node.test.ts
pnpm run test:go
```

## Running the suite

- `pnpm check` runs the repository's license, lint, both TypeScript compilers, Node/Chromium tests, build and dependency checks.
- `CI=true pnpm test` runs both test projects without writing missing goldens.
- `pnpm test tests/conformance/galaxie.test.ts` runs the twelve parity cases on both galaxie lanes.
- `node scripts/test-python.ts ../tests/conformance/cases-pydantic-ai-delegation-suite` checks the new delegation goldens and native approval reload. Rebuild with `node scripts/build-python-wheels.ts` before `pnpm exec vitest run --project node tests/conformance/pydantic-ai-delegation-conformance.node.test.ts`; the new suite runs on Node Pyodide only. From `python/`, `uv run --locked --offline python -I ../scripts/record-pydantic-ai-delegation-conformance.py --check` verifies its three goldens without writing them.
- `node scripts/test-python.ts ../tests/conformance/cases-pydantic-ai-child-approval` checks the three child approval goldens and native reload. Rebuild the wheel before `pnpm exec vitest run --project node tests/conformance/pydantic-ai-child-approval-conformance.node.test.ts`. From `python/`, `uv run --locked --offline python -I ../scripts/record-pydantic-ai-child-approval-conformance.py --check` verifies its goldens without writing them.
- CI runs the suite as separate jobs. `GALAXIE_TEST_GROUP` selects a file group for one `pnpm test` run: `general` (everything that does not load the Pyodide wheels, including the Go tests), `python-dspy`, `python-pydantic`, `python-adk` and `python-rest` (the rest of the wheel-loading tests); `python` is the four Python groups together. The groups share no file and together hold every file, so unset runs the whole suite as before. A pull request that changes only documents, Go, or packages no Python test reads skips the Python jobs (`scripts/ci-scope.ts`); a push to `main` always runs all of them.

Goldens are updated only by the native Node snapshot command, `pnpm conformance:update`, when intentionally changing the baseline. Review any resulting diff. Runtime control work must leave the existing goldens and compatibility matrix unchanged.


## ID-less interrupts

The separate `IDLESS_CASE_NAMES` registry keeps the original twelve cases and
compatibility matrices unchanged; the Python port covers those original twelve.
`idless-submit` and `idless-sequence` compare native Node, galaxie Node and Chromium
with zero differences, using bare resumes and pauses without native IDs.
`idless-shapes.json` records native interruption, body/effect counts and answer
application beside the asserted galaxie publication/refusal outcome. It includes
parallel Send, mixed IDs, repeated calls, NodeInterrupt/raw GraphInterrupt, compiled
children and a body-invoked child. The body child pauses on its parent task without
a child checkpoint namespace, publishes once and completes after one answer;
compiled children with a namespace publish nothing and fail `unsupported`.

`idless-recovery.test.ts` covers unaccepted, accepted-before-resume, held mid-resume
(including abort), completed-before-inbox-consumption and uninterrupted windows for
`sync`, `async` and `exit` on Node and Chromium. Identity remains stable, applications
remain one, consumed inbox entries reject duplicates, and restored values register
before replay. `exit` has no mid-run null-task resume write; `sync` and `async` do.
`idless.test.ts` checks repeated reads, reversed saver writes, forged/stale IDs,
invalid actions/payloads, unfinished siblings, refusal restore behavior and duplicate
answers. `indexeddb.test.ts` adds parity and close/reopen reload for both cases.

Exact valid NodeInterrupt/raw GraphInterrupt requests publish once and fail on the
first answer; recovery retains the accepted entry and retries that failure. A
refused second call in one node restores with `executor_error`. Earlier answers
already folded into graph state are outside latest-pending-write registration;
core registers accepted inbox payloads when recovery is configured. Second pauses
inside body-invoked children, repeated child pauses, loop revisits, real models and
Python ID-less behavior are unmeasured. Firefox and WebKit have CI report gates
only. See [author guidance and limits](../../packages/adapter-langgraph/README.md#id-less-interrupts). The [pause-time discriminator spike](../../spikes/langgraph-nodeinterrupt-pause-time/README.md) records **alternative**: P7/P8 break strict parsing or stream parity, P9/P10 lose restore signals, and P12 verifies the complete-config `requestInteraction` replacement; shipped behavior is unchanged.

Run the focused evidence without updating existing goldens:

```sh
pnpm exec vitest run --project node packages/adapter-langgraph/test/idless.test.ts tests/conformance/idless.node.test.ts tests/conformance/idless.test.ts tests/conformance/idless-recovery.test.ts
pnpm exec vitest run --project 'browser (chromium)' tests/conformance/idless.test.ts tests/conformance/idless-recovery.test.ts tests/conformance/indexeddb.test.ts
```

## DSPy paused-session state binding spike

The outcome rule and predictions were fixed before the Node and Chromium runs
(2026-11-11). Supported only if the state-only candidate passes every detection, identical-byte replay, non-sticky rollback, legacy acceptance, old-code refusal, untouched-surface and bounded-metadata criterion in every required lane. Unmeasured counts as failed. Otherwise alternative if all unchanged fingerprint recipe cases pass, else refused. If only unrelated JSON causes an identical-byte failure, measure the Module.load candidate in all lanes before selecting alternative.

**Status: shipped (2026-11-11).** The table below preserves the test-only spike
observations; shipped-code observations follow it. Native spike baseline:
`test_dspy_state_durable.py` and `test_dspy_durable.py`: 25 passed, matching #203.

**Spike outcome: supported (design proven).** All required criteria passed.
The implementation now binds JSON automatically; the
[author recipe](../../packages/adapter-pyodide/README.md#paused-sessions-and-a-changed-state-file)
covers Python sources and files outside JSON.

| Scenario | Prediction | Native observation | Node observation | Chromium observation |
| --- | --- | --- | --- | --- |
| `bind-early-same` | completes | completes | completes | completes |
| `bind-early-inert` | unrecoverable | unrecoverable; original bytes resume | unrecoverable; original bytes resume | unrecoverable; original bytes resume |
| `bind-late-same` | completes | completes | completes | completes |
| `bind-late-prompt` | unrecoverable | unrecoverable; original bytes resume | unrecoverable; original bytes resume | unrecoverable; original bytes resume |
| `bind-late-inert` | unrecoverable | unrecoverable; original bytes resume | unrecoverable; original bytes resume | unrecoverable; original bytes resume |
| `bind-early-prompt` | unrecoverable | unrecoverable; original bytes resume | unrecoverable; original bytes resume | unrecoverable; original bytes resume |
| `bind-fingerprint-inert` | unrecoverable | unrecoverable; original bytes resume | Unmeasured (native only) | Unmeasured (native only) |
| `bind-legacy-late-prompt` | completes | completes | completes | completes |

The deciding probes are `bind-early-inert`, `bind-late-prompt`, `bind-late-inert`
and `bind-early-prompt` in all three lanes, plus `bind-fingerprint-inert` natively.
Each refused at restore with fixed `unrecoverable` text, zero model/capability
requests and no `replayed` event. Checkpoint rows, pending writes and effect rows
were unchanged. Every refused session completed after restoring the original
bytes, with one replay notification and no repeated capability effect. Both
`same` cases matched the baseline output and counters with one replay notification.
`bind-legacy-late-prompt` accepted the old unbound record and used the new state.
The native author-recipe same-byte probe and all unchanged #203 cases passed.
No prediction diverged. Chromium also measures `bind-early-prompt`, which the
plan's browser unit omitted although its detection criterion required it.

The test-only [candidate](cases-dspy/state_bind_candidate.py) was imported from the
spike agent descriptor and patched `Executor._snapshot` and `_restore` in memory. It
freezes a SHA-256 over canonical JSON pairs of relative path and file-byte digest,
sorted by path, for all regular descriptor `.json` files outside `__pycache__`.
Only paused records gain one `stateBinding` metadata key with a 64-hex value
(82 bytes of JSON overhead); checkpoint and journal bytes are unchanged. Native
probes also show malformed bindings and removed JSON files fail closed, no-state
metadata remains byte-identical, and compact completed sessions accept a new run
under changed state with distinct capability effects.

Findings:

- **Metadata format changes.** The candidate keeps `v: 1` and adds an optional
  key. New code reads old unbound records; old code refuses bound records without
  writing. The shipped decision below retains the optional key under ADR-0018
  decision 7. The spike did not measure legacy sessions that pause again.
- **No core contract change was needed.** The shipped driver and adapter carry
  opaque metadata unchanged. Core never reads this framework-specific binding.
- **JSON-only scope fits the measured state.** A Python comment edit changes the
  all-files digest but leaves the state-only digest unchanged. JSON whitespace,
  renaming and addition change both. Directory iteration order and `__pycache__`
  distractors do not affect them. Python code drift remains guarded only where it
  changes journaled requests. Even unused descriptor JSON and whitespace count
  as changed bytes, so this can refuse an otherwise equivalent deployment.
- **Hash what Python reads.** The Node BOM probe shows the Worker fingerprint
  equals SHA-256 of the BOM-stripped UTF-8 bytes and differs from the served bytes.
  Fatal UTF-8 decoding remains unchanged.
- **Module.load comparison.** A native global wrapper of DSPy 3.4.1
  `BaseModule.load` produced the same one-file manifest digest, then restored the
  original method. `load_state(dict)` bypassed it while descriptor enumeration
  still found the file. Its global, version-specific hook misses that loading
  path, so it is not preferred over descriptor JSON enumeration.

This is a consistency check against accidental swaps, not integrity protection.
Snapshots remain unauthenticated. Measured versions: DSPy 3.4.1, CPython 3.14.5,
Pyodide 314.0.7, Node 24.15.0 and Playwright 1.64.1 Chromium 156.0.8078.4.
Unmeasured: Firefox,
WebKit, real models, other DSPy versions, concurrent tabs, a legacy session that
pauses again, forged checkpoint metadata and large many-file descriptors were
unmeasured by the spike. Existing goldens, matrices, locks and recorders remain
unchanged by the shipped implementation.

The candidate remains uninstalled and is used only by the native descriptor-scope
and `Module.load` comparison test; Worker descriptors no longer serve it.

Historical spike verification (all passed):

- `node scripts/test-python.ts ../tests/conformance/cases-dspy/test_dspy_state_bind.py`
  — 15 candidate probes.
- `node scripts/test-python.ts ../tests/conformance/cases-dspy/test_dspy_state_durable.py ../tests/conformance/cases-dspy/test_dspy_durable.py`
  — 25 unchanged baseline probes.
- `python/.venv/bin/python -I scripts/record-dspy-conformance.py --check` — 38 cases.
- `python/.venv/bin/python -I scripts/record-dspy-state-conformance.py --check`
  — 5 states and 7 cases.
- `node scripts/build-python-wheels.ts` before Node and browser runs.
- `pnpm exec vitest run --project node tests/conformance/dspy-state-bind.node.test.ts`
  — 9 tests, including the BOM and scenario-family probes.
- `pnpm exec vitest run --project node tests/conformance/dspy-state-restore.node.test.ts examples/rag-browser/test/dspy-state-conformance.node.test.ts`
  — 35 existing and new tests, including Chromium page reload through IndexedDB
  with unchanged CSP, external-request and response-header assertions.
- `pnpm exec vitest run --project node tests/conformance/dspy.node.test.ts tests/conformance/dspy-restore.node.test.ts tests/conformance/dspy-state.node.test.ts tests/conformance/dspy-state-limits.node.test.ts examples/rag-browser/test/dspy-conformance.node.test.ts`
  — 139 passed, one pre-existing skip.
- `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm typecheck:ts6`,
  `pnpm typecheck:python`, `pnpm check:docs` — passed. An initial new-test
  optional-chain lint error was fixed; unrelated formatter edits were reverted.
- `VITEST_MAX_WORKERS=4 pnpm check` — passed, including Node/Chromium, Python,
  Go, build, license, dependency, documentation and size gates.
- `git diff --stat main -- python/galaxie/src 'packages/*/src' 'tests/conformance/golden*' 'tests/conformance/compatibility-matrix*' pnpm-lock.yaml python/uv.lock python/requirements.lock scripts`
  — empty; original state fixtures and #203 source/support files also unchanged.

### Shipped binding evidence

The shipped driver freezes the JSON manifest before importing the author entry,
only for durable Workers. Paused metadata gains `stateBinding` under `v: 1`;
completed and unrecoverable records never carry it. Old code's exact key-set check
refuses bound records, so a library rollback leaves them unreadable until newer
code returns. The frozen check from commit `3731271` is covered natively. Every
malformed stored binding refuses before a session is registered. Direct callers
with malformed preparation bindings fail `unsupported` before publishing a record. Unreadable JSON fails
durable boot with `unsupported`; non-durable boot skips the scan. The 82-byte JSON
key consumes about 110 base64 characters of the existing 1 MiB pause headroom.

| Scenario | Native CPython | Node Pyodide | Chromium IndexedDB reload |
| --- | --- | --- | --- |
| `bind-early-same` | completes; one replay | completes; one replay | completes; one replay |
| `bind-early-inert` | refuses; original bytes resume | refuses; original bytes resume | refuses; original bytes resume |
| `bind-late-same` | completes; one replay | completes; one replay | completes; one replay |
| `bind-late-prompt` | refuses; original bytes resume | refuses; original bytes resume | refuses; original bytes resume |
| `bind-late-inert` | refuses; original bytes resume | refuses; original bytes resume | refuses; original bytes resume |
| `bind-early-prompt` | refuses; original bytes resume | refuses; original bytes resume | refuses; original bytes resume |
| `bind-fingerprint-inert` | refuses; original bytes resume | Unmeasured (native only) | Unmeasured (native only) |
| `bind-legacy-late-prompt` | completes under new state | completes under new state | completes under new state |
| Legacy session pauses again | second pause gains binding; changed JSON then refuses | Unmeasured | Unmeasured |

Every refusal above returns `unrecoverable`, with zero live model/capability
requests, no replay notification and unchanged checkpoint, pending-write and
effect rows. Rollback completes with one replay and no repeated capability effect.
Same-byte cases preserve baseline output and counters. Node compares each freshly
paused binding with an independent manifest oracle; its BOM probe matches decoded
bytes and differs from served bytes. Chromium checks a fresh 64-hex key before
building legacy records by removing only that key from IndexedDB metadata.
The earlier eight-scenario swap family keeps all outcomes: changed-state cases
use legacy unbound rows, while identical-state cases also exercise bound rows.

Any descriptor JSON edit counts, even unused JSON or whitespace. Python sources
remain outside the manifest. This is a consistency check against accidental swaps,
not integrity protection: metadata is unauthenticated. Firefox, WebKit, real models,
other DSPy versions, concurrent tabs, forged metadata, large many-file descriptors
and legacy sessions that pause again outside native CPython remain unmeasured.

Shipped verification:

- `node scripts/test-python.ts galaxie/tests/test_dspy_state_binding.py galaxie/tests/test_dspy.py`
  — 115 passed; pinned manifest vector independently cross-checked with Node crypto.
- `node scripts/test-python.ts ../tests/conformance/cases-dspy/test_dspy_state_bind.py ../tests/conformance/cases-dspy/test_dspy_state_bind_spike.py ../tests/conformance/cases-dspy/test_dspy_state_durable.py ../tests/conformance/cases-dspy/test_dspy_durable.py`
  — 41 passed, including all 25 baseline probes.
- `pnpm run typecheck:python` — passed.
- `python/.venv/bin/python -I scripts/record-dspy-conformance.py --check` — 38 cases.
- `python/.venv/bin/python -I scripts/record-dspy-state-conformance.py --check`
  — 5 states and 7 cases.
- `node scripts/build-python-wheels.ts` — passed before Node and browser tests.
- `pnpm exec vitest run --project node tests/conformance/dspy-state-bind.node.test.ts tests/conformance/dspy-state-restore.node.test.ts examples/rag-browser/test/dspy-state-conformance.node.test.ts`
  — 44 passed, retaining CSP, external-request and response-header assertions.
- `pnpm exec vitest run --project node tests/conformance/dspy.node.test.ts tests/conformance/dspy-restore.node.test.ts tests/conformance/dspy-state.node.test.ts tests/conformance/dspy-state-limits.node.test.ts examples/rag-browser/test/dspy-conformance.node.test.ts packages/adapter-pyodide/test/dspy-gate.node.test.ts`
  — 140 passed, one pre-existing skip.
- `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm typecheck:ts6`,
  `pnpm check:docs` — passed; unrelated formatter changes reverted.
- `VITEST_MAX_WORKERS=4 pnpm check` — passed after the preparation-validation
  review fix: 6,259 Node/Chromium tests passed, 162 skipped; 1,104 native Python
  tests passed; Go, build, license, dependency, documentation and size gates passed.
- `git diff --stat main -- 'tests/conformance/golden*' 'tests/conformance/compatibility-matrix*' pnpm-lock.yaml python/uv.lock python/requirements.lock`
  and `git diff --stat main -- packages/core` — empty; protected files remain
  byte-identical. Recorders are unchanged.

## DSPy parallel and threaded Evaluate spike

### Async branch-helper shipping refusal

The gate question is decided in the [next subsection](#divergence-persistence-decision).

On 2026-11-13, the attempt to ship a keyed async helper records **refused**.
The proposed helper was withdrawn at that gate; the later [shipped helper](#shipped-async-branch-helper) meets the revised gate below.
Use a sequential loop of `await module.acall(...)` and keep code outside
journaled calls deterministic. Thread-pool `Parallel` and `Evaluate` retain their
fixed `unsupported` refusal.

The native implementation experiment passed reverse-arrival scope and checkpoint
byte comparisons with real and inlined thread hops, fresh-driver replay, silent
groups, caught author exceptions and a lost third-write receipt. It failed the
stored-row acceptance check: renaming a recorded key returned `unrecoverable`
with zero further model or capability requests, but added revision
`00000000000000000002`, a compact checkpoint with `status: unrecoverable`,
`input: null` and `journal: []`. The original paused row stayed byte-identical;
the complete row set did not. Earlier live Node Pyodide comparisons passed, but
durable shipping support was not established.

The cause is the existing driver's deliberate poison-marker write after runtime
divergence, in `packages/adapter-pyodide/src/dspy-driver.ts`. It prevents later
restores from retrying a divergent program. Preserving the complete row set would
require revising that recovery contract or suppressing its protection. Neither
is part of this change. This differs from restore-time rejection of an unknown
entry key, which happens before session registration and writes no marker.

The retained tests reproduce the same storage conflict using the existing
test-only branch journal, without a production helper:

```sh
cd python
.venv/bin/python -m pytest ../tests/conformance/cases-dspy/test_dspy_fanout.py -q
cd ..
pnpm exec vitest run --project node tests/conformance/dspy-fanout.node.test.ts
```

Native tests cover both a changed request and a removed branch. Node Pyodide
covers a removed branch in a fresh Worker. Both assert zero further model or
capability requests, unchanged earlier rows and the added poison marker. Native
also verifies that a subsequent restore stays unrecoverable. These are scripted
tests on DSPy 3.4.1, CPython 3.14.5, Node 24.15.0 and Pyodide 314.0.7.
New Chromium fan-out live/reload probes, Firefox, WebKit, real models and other
DSPy versions remain unmeasured. Existing goldens, matrices, recorders, locks and
production source are unchanged. A supported helper needs a separately scoped
decision about divergence persistence before another shipping attempt.

### Divergence persistence decision

On 2026-11-13, the outcome is **accepted** for the existing poison checkpoint
and the revised acceptance gate for a later helper. The helper still does not
ship; retrying it is separately scoped. [ADR-0018](../../docs/adr/0018-python-agents-through-pyodide.md#dspy-divergence-persistence-decision-2026-11)
records the decision and rejected driver change.

The native [sequential pin](cases-dspy/test_dspy_divergence_persistence.py)
pauses after a capability call, then resumes with that call's input changed or
the call removed. Both return fixed `unrecoverable` before any further model or
capability request. Every earlier row and write stays byte-identical. Exactly
one checkpoint is appended with the next 20-digit revision and the previous
latest id as `parentId`: `status: unrecoverable`, `input: null`, `journal: []`,
metadata keys `v`, `dspy`, `adapter`, `session`, and one `__interrupt__` write
at index -3 whose JSON value is null. The stores do not retain `interruptIds`.
A fresh driver with the original program refuses its pending read without
requests or another write. An unchanged-program control resumes and completes
without a poison checkpoint. This new sequential pin is native-only; the
native and Pyodide lanes execute the same driver string.

The [native branch pin](cases-dspy/test_dspy_fanout.py) asserts the same marker
shape for a changed request and a removed branch. The
[Node Pyodide pin](dspy-fanout.node.test.ts) removes a branch in a fresh Worker
and checks the marker, earlier rows/writes and zero further requests. A third
Worker using the original sources still gets `unrecoverable`, with no model or
capability requests, post-termination requests or added row. Both lanes check
that restoring the original program preserves the poisoned rows and writes.

Runtime divergence and restore-time refusal have different persistence rules:
`_Run.begin`/`_Run.frontier` refuse mismatched replay before further dispatch,
then `Executor.run` clears the session and the registered
[driver](../../packages/adapter-pyodide/src/dspy-driver.ts) commits the poison
marker. Unknown entry keys, malformed records and metadata/binding mismatches
fail before registration and write nothing. The unchanged
`test_old_reader_refuses_branch_records_without_changing_stored_rows` in
[the candidate tests](cases-dspy/test_dspy_parallel_candidate.py) pins the
restore-time path; malformed-record tests in that file remain part of the run.

The marker prevents later retry of a divergent program, including the earlier
unkeyed crash probe's repeat-write class (`alpha` under another scope). Requiring
the complete row set to stay unchanged adds no protection; it preserves rollback
resumability, which sequential programs also lose after runtime divergence.
Suppressing the marker for branches would require production changes and a
branch-specific rule that leaves divergence retryable. That option is rejected.
The cost is loss of the session even under the original program: the user must
start over. The revised helper gate therefore requires zero further requests,
unchanged earlier rows/writes, one compact marker after the divergent execution
and refused later restores; restore-time refusals still require no new row.

The sequential probe also observed a second compact marker after a second execute
on the poisoned session in the same driver, with zero requests. Marker counts
after repeated executes are deliberately not asserted. Hosts stop at the refused
pending read; bounding repeated markers is a separate follow-up.

Focused verification (give DSPy commands a timeout of at least 900000 ms):

```sh
cd python
.venv/bin/python -m pytest ../tests/conformance/cases-dspy/test_dspy_divergence_persistence.py -q
.venv/bin/python -m pytest ../tests/conformance/cases-dspy/test_dspy_fanout.py ../tests/conformance/cases-dspy/test_dspy_parallel_candidate.py -q
cd ..
pnpm exec vitest run --project node tests/conformance/dspy-fanout.node.test.ts
```

Evidence is scripted on DSPy 3.4.1, CPython 3.14.5, Node 24.15.0 and Pyodide
314.0.7. Chromium, Firefox, WebKit, real models and other DSPy versions remain
unmeasured for this decision. Checkpoint validation establishes consistency,
not integrity; metadata is unauthenticated. ADR-0012 controls, production source,
checkpoint formats and existing goldens, matrices, fixtures, recorders and locks
are unchanged.

### Shipped async branch helper

On 2026-11-13, `galaxie.dspy.branches` ships under the accepted poison-checkpoint
rule. The public helper uses author keys and local call ordinals, canonicalizes
the journal at join, and refuses missing replay entries before dispatch.
`fanout-single`, `fanout-write` and `fanout-multi` add new native goldens;
only these unordered cases sort requests, responses and capability queries.
Their replies are keyed by question label. Existing cases retain their original
ordering and bytes. Native reference branches use plain `asyncio.gather` with an
independent DSPy engine and tool, without the galaxie helper.

| Lane | Measured outcome |
| --- | --- |
| CPython | Forward/reversed arrival and real/inlined thread hops preserve checkpoint bytes, scopes and receipts. Fresh-driver replay is silent for the recorded group; a crash after two writes reuses receipts. Changed requests, removed/renamed keys, fewer/extra calls and added calling keys poison once before further requests; later restores add no row. Frozen pre-change records restore and re-snapshot byte-identically. Extracted pre-change code refuses new markers without registration. |
| Node Pyodide | The built wheel matches all three new goldens. Fresh Workers retain branch scopes, checkpoint bytes, silent replay, write deduplication and compact poison persistence. Malformed markers and unknown entry keys fail restore without a row. Nested, wide, streaming and branch-interaction refusals leave no task running. |
| Headless Chromium | The three live cases match native goldens under strict CSP and external-request aborts. `fanout-reload` reopens scoped IndexedDB in a fresh page and Worker: the joined group makes no additional request, one replay notification fires, and only the later live group dispatches. Shared state-binding reload tests remain green. |

The helper returns results in input order, caps groups at 32 branches and runs at
1000 non-empty groups, and accepts keys matching `[A-Za-z0-9_.-]{1,64}`. Branches
must await journaled calls sequentially; code outside journaled calls must be
deterministic. Ordinary author exceptions wait for siblings and raise in input
order; terminal failures and outer cancellation drain siblings. Cancelling a
replayed group preserves its stored pause for retry, proven natively and in a
fresh Node Worker; unconsumed entries on cancellation are not divergence.
Cancellation is recorded before cleanup, so a branch that catches it cannot
dispatch a model or capability request. Native and Node tests cover this guard.
Branch pauses, nested groups, streaming, concurrent calls inside one branch and
root journaled calls during a group remain fixed `unsupported`. Thread-pool APIs stay refused.
No partial group is persisted.

The optional `fanout` entry key stays under metadata `v: 1`; old readers already
refuse unknown keys before registration, so a version bump adds no rollback
safety. Root records remain byte-identical. Runtime divergence deliberately
appends one compact `unrecoverable` checkpoint with null input and empty journal,
parented on the previous revision, with one null interrupt write. Earlier rows
and writes remain byte-identical; the original program cannot resume that session
and the user starts over. Restore-time refusals add no row. These are consistency
checks, not integrity protection: stored metadata is unauthenticated.

Focused reproduction, after rebuilding the wheel with
`node scripts/build-python-wheels.ts`:

```sh
cd python
.venv/bin/python -m pytest galaxie/tests/test_dspy_branches.py galaxie/tests/test_dspy.py galaxie/tests/test_dspy_state_binding.py galaxie/tests/test_dspy_gate.py galaxie/tests/test_dspy_lint.py
.venv/bin/python -m pytest ../tests/conformance/cases-dspy
.venv/bin/python ../scripts/record-dspy-conformance.py --check
.venv/bin/python ../scripts/record-dspy-state-conformance.py --check
cd ..
pnpm run typecheck:python
pnpm exec vitest run --project node tests/conformance/dspy.node.test.ts tests/conformance/dspy-branches.node.test.ts tests/conformance/dspy-fanout.node.test.ts tests/conformance/dspy-parallel.node.test.ts tests/conformance/dspy-restore.node.test.ts
pnpm exec vitest run --project node examples/rag-browser/test/dspy-conformance.node.test.ts examples/rag-browser/test/dspy-state-conformance.node.test.ts
pnpm run check:docs
```

Give DSPy test processes at least 900000 ms. The evidence uses scripted models on
DSPy 3.4.1, CPython 3.14.5, Node 24.15.0 and Pyodide 314.0.7. Chromium divergence
reload, Firefox, WebKit, real models, other DSPy versions and ReAct branches remain
unmeasured. Pauses within groups require a new partial-group design. No core,
bridge, driver, lock or third-party wheel input changed.

### Original spike record

On 2026-11-11 the recorded outcome is **alternative** for `dspy.Parallel` and
**alternative** for threaded `dspy.Evaluate`, with a replacement proven as a
test-only design. Use a sequential loop of `await module.acall(...)` today.
Neither verbatim API nor the candidate gains shipped support in this spike.

The R0 verbatim rows below were superseded on 2026-11-12 by the
[shipped thread-pool refusal](#dspy-thread-pool-fan-out-refusal). The dated spike
observations and predictions remain unchanged.

The [fixed rule and predictions](cases-dspy/parallel-fixtures.json) were committed
before Node measurements. An unmeasured required criterion fails. Per gap, the
rule chooses verbatim support only after parity, replay, writes once,
divergence-before-dispatch and tidy refusals pass in native CPython and Node
Pyodide. Otherwise it chooses an alternative if shipped async single-call
fan-out passes those checks in both lanes, or a design-only alternative if the
candidate additionally passes unchanged-root bytes, old/new compatibility and
bounds in their required lanes. Otherwise the outcome is refused. The deciding
probes are `par-verbatim-parallel-*` plus `par-fan-*` for Parallel, and
`par-verbatim-evaluate-*` plus `par-fan-eval-loop` for Evaluate. The verbatim
probes fail, shipped replay has native counterexamples, and the candidate passes
the required measurements. The conditional prepare-time refusal therefore did
not fire. Follow-up implementation and fixed thread-pool refusal are drafted in
the PR; no tracker issue was filed by the spike.

Measured versions: DSPy 3.4.1, CPython 3.14.5, Node 24.15.0, Pyodide 314.0.7 and
pnpm 11.21.0. Native orders are forward, reversed and rotated; Node exercises the
forward/reversed orders named below. Replies depend on question content, never
arrival order. Native uses events; Node releases each promise only after the
preceding response is posted to the Worker. Host write confirmations remain
enabled, with binding concurrency 4. A crash disposes the runtime after two real
succeeded receipts while the third confirmation remains unapproved.

In this table, R0 is shipped code and R1 is the test-only candidate. Request counts
are live model requests; writes count actual host effects, excluding replayed
receipts. A dash means that candidate comparison is inapplicable. **Every new
spike probe is unmeasured in Chromium, Firefox and WebKit.** Existing browser
regression gates do not measure these new scenarios.

| Probe | Prediction | Native observation, R0 / R1 | Node observation, R0 / R1 |
| --- | --- | --- | --- |
| `par-verbatim-parallel-threads` | Native success with `None`; Node `executor_error` | Success, `[None, None, None]`, 0 requests/writes / — | `executor_error`, 0 requests/writes / — |
| `par-verbatim-parallel-sequential` | `unsupported` | `unsupported`, 0 requests/writes / — | `unsupported`, 0 requests/writes / — |
| `par-verbatim-evaluate-threads` | Native score 0.0; Node `executor_error` | Success, score 0.0, three empty predictions, 0 requests/writes / — | `executor_error`, 0 requests/writes / — |
| `par-verbatim-evaluate-sequential` | `unsupported` | `unsupported`, 0 requests/writes / — | `unsupported`, 0 requests/writes / — |
| `par-verbatim-thread-start` | Worker thread/pool both `RuntimeError` | Both started, 0 requests/writes / — | Both `RuntimeError`, 0 requests/writes / — |
| `par-fan-single` | Live parity in every order | Native output and full payload multiset match, 3 requests / same | Forward/reversed parity, 3 requests / same |
| `par-fan-write` | Stable scopes across crash/re-dispatch | Two writes before crash, one new write after reversed re-dispatch; 3 effects total / same | Same 2 + 1 writes, 3 succeeded receipts / same |
| `par-fan-multi` | Live parity; R0 re-dispatch fails, R1 completes | Live parity, 6 requests/3 writes. Crash then reverse: `unrecoverable`, observed duplicate `alpha` under a new scope / 3 total writes, parity after re-dispatch | Reversed live parity, 6 requests/3 writes / same. Multi-call crash is unmeasured in Node |
| `par-fan-two-stage-single` | R0 and R1 replay and complete | **Diverged:** all three measured R0 orders ended `unrecoverable`, 0 resume requests; observed initial order `alpha,gamma,beta` / completes, 3 new after-join requests, one `replayed` event | Completes, 3 new after-join requests, one `replayed` event / same |
| `par-fan-two-stage-multi` | R0 fails, R1 completes | `unrecoverable`, 0 resume requests / completes, 6 new after-join requests and 3 new writes, one `replayed` event | Same refusal, 0 live requests/writes / same completion with opposite reply order |
| `par-fan-diverge` | Changed prompt or removed branch refuses before dispatch | Both end `unrecoverable`, 0 post-resume requests/writes / same; mixed-prefix barrier probes also send 0 requests | Both end `unrecoverable`, 0 post-resume requests/writes / same |
| `par-fan-pause-in-branch` | R0 may strand a sibling; R1 drains and refuses | `unsupported`, cleared journal, 1 held model request and 1 sibling at return / `unsupported`, 0 surviving tasks | `unsupported`, 1 sibling at return / `unsupported`, 0 surviving tasks |
| `par-fan-concurrent-pauses` | `unsupported` | `unsupported`, 0 requests/writes/tasks / same | `unsupported`, 0 requests/writes/tasks / same |
| `par-fan-eval-loop` | R0 and R1 parity, including replay | Live score 100.0 and 4 requests; **diverged:** R0 reload `unrecoverable`, 0 resume requests / score 100.0, 4 initial and 0 resume requests, one `replayed` event | Live/native parity and silent replay, score 100.0 / same |
| Candidate group validation | Fixed `unsupported`, no stranded work | Invalid/duplicate keys, nested groups, streaming and width 33 refuse; empty/one-branch groups work / R1 only | Same refusals, 0 requests/writes/surviving tasks / R1 only |
| Unused format, restore and bounds | Root bytes unchanged; old/new fail closed; bounded entries | Root checkpoint/metadata byte equality; legacy restore completes; old reader refuses branch record with unchanged rows; one optional string, at most 70 characters, width cap 32; existing pause-size refusal / R1 only | Width/guard refusal measured; byte equality and old-reader checks are native-only required probes |

All Node observations assert zero model/capability requests after termination,
zero Worker errors and loopback fixture requests only. The native harness records
orphan tasks before cancelling them; cleanup is not counted as a candidate pass.
The native reference runs plain DSPy `Parallel(num_threads=3)` and
`Evaluate(num_threads=1/3)` with content-keyed custom engines. Live and continued
outputs and full model payload multisets match that independent reference.

### What the Worker's single thread allows

Asyncio branches and concurrent bridge requests work: the reply gates wait for
all branch requests before releasing any reply. `threading.Thread.start` and
`ThreadPoolExecutor.submit` raise `RuntimeError` in this Worker. Synchronous model
entry points cannot await the bridge. Natively, DSPy's pool catches ordinary
exceptions, so Parallel can return `None` and Evaluate can return score 0.0 while
the run reports success. The one-thread path sees the active run's refusal and
ends `unsupported`.

The prediction that single-call gather starts in task-creation order was wrong
natively: DSPy 3.4.1 awaits `asyncio.to_thread(prepare, ...)` before journal entry.
Recorded initial order `alpha,gamma,beta` differed from replay. Plain gather
single-call and evaluation replay pass in Node, and write-only crash re-dispatch
keeps receipts in both lanes, but these limits do not establish a portable async
replacement. Multi-call branches can allocate another branch's scope, and the
native crash probe actually repeated `alpha` before `unrecoverable` propagated.
Multi-call work should remain sequential until the follow-up ships.

The native crash-redispatch probe's exact write sequence depends on DSPy's
`asyncio.to_thread` hops; the pinned shipped-code test inlines those hops to
deterministically record `unrecoverable` with a repeated `alpha`. Under natural
thread scheduling, the reversed run can instead allocate the original scopes
and complete `ok` with each write once, which a separate test accepts while
checking output and receipt identity. Both outcomes preserve the ADR-0012
controls; the repeat remains the documented hazard for the branch journal
follow-up to address.

```python
answers = []
for label in ('alpha', 'beta', 'gamma'):
    answers.append((await module.acall(question=label)).answer)
```

Author code must be deterministic apart from journaled calls. The candidate uses
static branch keys, branch-local ordinals and a barrier before live calls;
divergent replay releases waiting siblings without dispatch. It cancels and
awaits all branch tasks before returning. The initial Node helper released all
promises together and failed four ordering assertions; the final helper gates on
actual response posts. That was a measurement-harness correction, not a change
to shipped code or to the predictions.

### Journal format and core contracts

The candidate adds one optional `branch` field to model and capability entries,
holding `<key>/<ordinal>`. Keys are ASCII, 1–64 characters; ordinals are bounded
to keep the whole marker at most 70 characters. The group cap is 32. The existing
pause-size check counts branch bytes. Root-only checkpoint and metadata bytes
remain identical. The real restore validator is reused after validating and
removing only that optional key; all other shape checks remain in force. New
code restores legacy records. Unmodified code rejects the added entry key with
fixed `unrecoverable` and does not change stored rows. Metadata stays `v: 1` in
the experiment; shipping must decide the optional-key/version policy under
[ADR-0018 decision 7](../../docs/adr/0018-python-agents-through-pyodide.md#decision).

No core contract change was needed: Python owns the journal and effect scopes;
the adapter transports opaque checkpoint bytes and core treats scopes as opaque
strings. Existing confirmations, budgets, routing and ADR-0012 controls remain.
The candidate's install handle restores every replaced attribute; tests assert
that uninstall does so. No shipped Python or package source, existing golden,
matrix, recorder or lock changes in this spike.

Chromium, Firefox, WebKit, real models and other DSPy versions are unmeasured for
these probes. Successful streaming fan-out, nested groups, pauses inside branches
and ReAct loops in branches are not established as product behavior. Refusal
probes cover the first three; no ReAct fan-out claim follows from them.

### Reproduce the parallel measurements

Run from the repository root, except where `cd python` is shown. Fetch the wheel
cache if absent, then rebuild the local wheel before Node or browser tests.
Recorder commands always require `--check`.

```sh
node scripts/build-python-wheels.ts
cd python
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest ../tests/conformance/cases-dspy/test_dspy_parallel_baseline.py -q
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest ../tests/conformance/cases-dspy/test_dspy_parallel_candidate.py -q
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest ../tests/conformance/cases-dspy -q
cd ..
python/.venv/bin/python scripts/record-dspy-conformance.py --check
python/.venv/bin/python scripts/record-dspy-state-conformance.py --check
pnpm exec vitest run --project node tests/conformance/dspy-parallel.node.test.ts
pnpm exec vitest run --project node tests/conformance/dspy.node.test.ts tests/conformance/dspy-restore.node.test.ts tests/conformance/dspy-state.node.test.ts tests/conformance/dspy-state-restore.node.test.ts tests/conformance/dspy-state-bind.node.test.ts tests/conformance/dspy-state-limits.node.test.ts
pnpm run typecheck:python
pnpm format
pnpm lint
pnpm typecheck
pnpm typecheck:ts6
pnpm run check:docs
VITEST_MAX_WORKERS=4 pnpm check
git diff --name-status main
```

Focused evidence: 32 baseline and 43 candidate native tests pass; the full native
DSPy folder passes 172 tests. The new Node lane passes 31 tests, and the six
existing Node suites pass 94 with one opt-in measurement skipped. Both recorder
checks pass (38 native cases; five states and seven native state cases).

## DSPy thread-pool fan-out refusal

On 2026-11-12, threaded `dspy.Parallel` and `dspy.Evaluate`, including the default
thread count, gained fixed `unsupported` refusal. They no longer quietly return
`None` entries or score 0.0 natively, or the generic `executor_error` in the Worker.
The error message is exactly `This operation is unsupported.` All refusal rows
below have zero model requests, capability calls, orphan tasks and requests after
termination; Node also records zero Worker errors and only loopback asset requests.
Evidence uses scripted replies on DSPy 3.4.1, CPython 3.14.5, Node 24.15.0,
Pyodide 314.0.7 and pnpm 11.21.0.

| Scenario | PR #214 native / Node observation | Current native observation | Current Node observation |
| --- | --- | --- | --- |
| `par-verbatim-parallel-threads` | Three `None` entries / `executor_error` | `unsupported` | `unsupported` |
| `par-verbatim-evaluate-threads` | Score 0.0, three empty predictions / `executor_error` | `unsupported` | `unsupported` |
| `par-verbatim-parallel-sequential` | `unsupported` / `unsupported` | `unsupported` | `unsupported` |
| `par-verbatim-evaluate-sequential` | `unsupported` / `unsupported` | `unsupported` | `unsupported` |
| `par-verbatim-thread-start` | Thread/pool both started / both `RuntimeError` | Both started; zero requests | Both `RuntimeError`; zero requests |
| `par-refuse-context` | Not measured | `unsupported` despite author `except BaseException` | Same fixed refusal |

`par-refuse-context` copies DSPy's settings into an empty Context without starting
a thread, then swallows the LM exception. The run still ends `unsupported`.
Native unit tests additionally cover real pools, default thread counts,
`max_errors=1`, `Exception`/`BaseException` catches, async LM calls from DSPy pool
workers, engine completion/streaming with lost context, grouped thread-start
errors, cleanup and a second supported run on the same executor. An ordinary
author `RuntimeError` keeps `executor_error`.

The threaded Parallel probe captures logger `dspy.utils.parallelizer`: **zero
records**, with **no example question text** logged. `_Termination` bypasses its
`Exception` handler. The sequential control still logs item text through DSPy;
galaxie neither adds diagnostic text nor suppresses DSPy logging.

Two snapshot pairs captured twice before the source edit now pin literal paused
and completed checkpoint/metadata bytes. Both recorder checks and the unchanged
native candidate, async fan-out, runtime, state and Node regression suites protect
supported behavior. No golden, matrix, lock, recorder, journal key or core contract
changes. The fixture adds only the new scenario name; its spike predictions stay
historical.

Residual limits: raw author-created threads without DSPy's propagated settings are
unattributed natively; a thread-start error caught by author code is invisible to
the executor. Stale settings hold only a weak reference and cannot affect a later
run. Any `RuntimeError` raised inside `Thread.start`, including misuse, maps to
`unsupported` if it reaches the executor. Chromium, Firefox, WebKit, real models
and other DSPy versions are **unmeasured** for these probes. Thread-pool fan-out
remains unsupported; use sequential `await module.acall(...)` loops. Supported
async fan-out remains follow-up `galaxie-fv4.3.17`. ADR-0012 controls are unchanged.

### Reproduce the thread-pool refusal

Run from the repository root except where `cd python` is shown. Rebuild the wheel
before Node tests; recorder commands always require `--check`.

```sh
cd python
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest galaxie/tests/test_dspy.py galaxie/tests/test_dspy_state_binding.py galaxie/tests/test_dspy_gate.py galaxie/tests/test_dspy_lint.py -q
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest ../tests/conformance/cases-dspy/test_dspy_parallel_baseline.py -q
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest ../tests/conformance/cases-dspy/test_dspy_parallel_candidate.py ../tests/conformance/cases-dspy/test_dspy_runtime.py -q
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest ../tests/conformance/cases-dspy -q
cd ..
python/.venv/bin/python scripts/record-dspy-conformance.py --check
python/.venv/bin/python scripts/record-dspy-state-conformance.py --check
pnpm run typecheck:python
node scripts/build-python-wheels.ts
pnpm exec vitest run --project node tests/conformance/dspy-parallel.node.test.ts
pnpm exec vitest run --project node tests/conformance/dspy-runtime.node.test.ts tests/conformance/dspy.node.test.ts tests/conformance/dspy-restore.node.test.ts tests/conformance/dspy-state.node.test.ts tests/conformance/dspy-state-restore.node.test.ts tests/conformance/dspy-state-bind.node.test.ts tests/conformance/dspy-state-limits.node.test.ts
pnpm run check:docs
pnpm format
pnpm lint
pnpm typecheck
pnpm typecheck:ts6
VITEST_MAX_WORKERS=4 pnpm check
git diff --name-status main
```

## DSPy sync entry points and runtime optimizers spike

The 2026-11-11 spike records sync entry points **refused**, model-calling runtime
optimizers **alternative** through offline JSON state, and runtime
`LabeledFewShot` **supported** with an LM rebind in the measured shapes. No
shipped source or core contract changed. The conditional fixed-refusal change
was not needed. These are scripted-model observations, not answer-quality results.

The [rule and predictions](cases-dspy/runtime-fixtures.json) were committed in
`b6c2e17` before measurements. Native CPython and Node Pyodide are required lanes;
an unmeasured support criterion fails. Support needs native output and model
payload parity; LabeledFewShot also needs deterministic demos and fresh-executor
replay. Otherwise a model-calling optimizer gets alternative only when measured
members tidy-refuse and the unchanged offline-state evidence still passes for
at least BootstrapFewShot. A native optimizer timeout is unmeasured, never a pass.
Sync migration to `aforward`/`acall` is the existing API, so tidy sync refusal
records refused. A Worker silent success, unfixed error, post-termination request
or hang would require the conditional refusal before assigning an outcome.
Native-only thread findings remain linked to `galaxie-fv4.3.18`.

Versions observed: DSPy 3.4.1, CPython 3.14.5, Node 24.15.0 and Pyodide 314.0.7.
Models always return the scripted `done` answer; trainsets have three examples.
In the table, request counts are model requests; every scenario has zero
capability requests, surviving tasks and requests after termination. Node has no
Worker errors and only loopback `/python/` asset requests. Prepare refusal is
thrown before the sync-only author's body executes.

| Scenario | Prediction | Native observation | Node observation |
| --- | --- | --- | --- |
| `rt-sync-forward-only` | Prepare `unsupported`, 0 requests | As predicted; body not run | As predicted; prepare rejects |
| `rt-sync-module-call` | `unsupported`, 0 | As predicted | As predicted |
| `rt-sync-forward-call` | `unsupported`, 0 | As predicted | As predicted |
| `rt-sync-lm-call` | `unsupported`, 0 | As predicted | As predicted |
| `rt-sync-swallowed` | `unsupported`, 0 despite fallback | As predicted; no fallback output | As predicted; no fallback output |
| `rt-sync-to-thread` | `unsupported`, 0 | As predicted | As predicted; measured first |
| `rt-sync-acall-control` | `done`, 1 | As predicted | As predicted |
| `rt-opt-bootstrap` | `unsupported`, 0 despite caught first failure | As predicted | As predicted |
| `rt-opt-mipro` | Fixed non-success, 0; `unsupported` expected, `executor_error` also tidy | `unsupported`, 0 | `unsupported`, 0 |
| `rt-opt-copro` | `unsupported`, 0 | As predicted | As predicted |
| `rt-opt-gepa` | Native fixed non-success or unmeasured timeout; Node `executor_error`, 0 | `unsupported`, 0; subprocess finished, no timeout | `executor_error`, 0; `gepa` absent |
| `rt-opt-labeled` | Native output, payload and demo parity; 1 | Passed | Passed |
| `rt-opt-labeled-naive` | `executor_error`, 0 without LM rebind | As predicted | As predicted |
| `rt-opt-labeled-two-stage` | Pause, restore, replay without dispatch; 2 total | Passed; matches same-executor completion and plain DSPy | Passed; 1 before pause, 0 during replay, 1 after frontier; plain-DSPy parity |

No prediction diverged. All six sync shapes decide refusal; the async control
is excluded. `rt-sync-swallowed` and `rt-opt-bootstrap` establish that catching
`Exception` cannot hide the recorded failure. MIPROv2 ends `unsupported`
before optional `optuna` is needed; COPRO reaches sync prompt
generation. GEPA uses a tiny metric-call budget and a network-denied native
subprocess bounded to 120 seconds. Nothing here installs optional dependencies.

The `to_thread` observation confirms the predicted fixed refusal in the Worker,
with the run context visible, rather than a thread-start error. It does not by
itself measure Pyodide's internal executor implementation. The reused thread-start
probe establishes that the Worker cannot start a thread or thread pool. A blocking
bridge would stall the event loop that delivers replies and handles cancellation
and budgets; that is architectural reasoning, not a blocking-bridge experiment.

LabeledFewShot makes no model call during compile. Its seeded two-demo projection
is Tokyo then Rome in both lanes, and model payloads match the plain-DSPy reference.
`reset_copy` clears predictor LMs; the measured pattern rebinds `GalaxieLM` after
compile and uses `acall`. The naive copy has no default LM and fails. The two-stage
program re-compiles on restore without changing the first request's digest, emits
one `replayed` event before live work and dispatches only the second request.
Author code must be deterministic apart from journaled calls. Runtime support is
measured behavior under shipped code; promotion to golden cases is separate work.

| Evidence | Reused or new | Lanes and scope |
| --- | --- | --- |
| No-run sync LM and sync-only module refusal, `python/galaxie/tests/test_dspy.py` | Reused | Native regression |
| #214 sequential Parallel/Evaluate refusal; thread/pool errors and native silent-swallow finding | Reused | Historical native/Node results; the two verbatim expectation tests were superseded on 2026-11-12 by the [thread-pool refusal](#dspy-thread-pool-fan-out-refusal). Async fan-out remains follow-up `galaxie-fv4.3.17`. |
| #196 seven offline-state cases, size bounds and round-trip catalog | Reused | Native/Node regressions rerun; prior Chromium evidence, no new state cases |
| #213 descriptor JSON binding of paused sessions | Reused | Prior native/Node/Chromium evidence; native/Node regressions rerun |
| Fourteen `rt-*` scenarios above | New | Native and Node only |
| Plain-DSPy labeled reference and fresh-executor replay | New | Native/Node output, payloads, seeded demos and replay frontier |

The [offline recipe](../../packages/adapter-pyodide/README.md#runtime-optimizers-and-the-offline-recipe)
uses optimize, JSON save, ship, load and LM rebind. Verified offline producers
remain LabeledFewShot, scripted-LM BootstrapFewShot, ReAct demos and an
instructions-only stand-in. Offline MIPROv2/COPRO/GEPA output is **unmeasured**.
Chromium, Firefox and WebKit runtime probes, real models, other DSPy versions,
KNNFewShot/Ensemble/SIMBA/BetterTogether/fine-tuning optimizers and optimizers
given an in-Worker plain `dspy.LM` are **unmeasured**. No core contract change is
needed; ADR-0012 controls, shipped source, goldens, matrices and locks are unchanged.

Reproduce from the repository root (rebuild wheels before any Worker tests):

```sh
node scripts/build-python-wheels.ts
cd python
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest ../tests/conformance/cases-dspy/test_dspy_runtime.py -q
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest ../tests/conformance/cases-dspy galaxie/tests/test_dspy.py galaxie/tests/test_dspy_gate.py galaxie/tests/test_dspy_state_binding.py -q
cd ..
python/.venv/bin/python scripts/record-dspy-conformance.py --check
python/.venv/bin/python scripts/record-dspy-state-conformance.py --check
pnpm run typecheck:python
pnpm exec vitest run --project node tests/conformance/dspy-runtime.node.test.ts
pnpm exec vitest run --project node tests/conformance/dspy.node.test.ts tests/conformance/dspy-restore.node.test.ts tests/conformance/dspy-state.node.test.ts tests/conformance/dspy-state-restore.node.test.ts tests/conformance/dspy-state-bind.node.test.ts tests/conformance/dspy-state-limits.node.test.ts tests/conformance/dspy-parallel.node.test.ts
pnpm format
pnpm lint
pnpm typecheck
pnpm typecheck:ts6
pnpm run check:docs
VITEST_MAX_WORKERS=4 pnpm check
git diff --name-status main
```

Focused results: native runtime 15 passed; native DSPy regression 304 passed;
Node runtime 15 passed; existing Node suites 125 passed and one opt-in measurement
skipped. Both recorder checks pass (38 cases; five states and seven state cases).


## DSPy provider strings, schema output, embeddings and retrievers spike

The 2026-11-11 spike records **alternative** for provider-string LMs,
**alternative** for native provider schema output, **refused** for embeddings and
**alternative** for service retrievers. No verbatim API gains new shipped support.
The [author recipes](../../packages/adapter-pyodide/README.md#provider-strings-schema-output-embeddings-and-retrievers)
state the host mapping, weaker typed-output guarantee and capability replacement.
No core contract change is needed. Shipped source, existing fixtures, recorders,
goldens, matrices and locks remain byte-identical; the conditional refusal unit
did not fire.

The [fixture](cases-dspy/provider-fixtures.json) fixes the rule and predictions in
commit `12d3a13`, before native or Node measurement. Support requires every named
verbatim member to complete with native output/payload parity in both required
lanes, using the router and broker. Otherwise an alternative requires tidy refusal
or explicitly recorded outside-bridge behavior, plus a measured replacement in
both lanes that delivers the goal with its changed guarantee stated. Without that
replacement the outcome is refused; unmeasured criteria fail. Rejected egress is
an informational trusted-code finding, not a refusal failure. A Worker hang,
silent success, non-fixed code, late request or Worker error would trigger the
conditional refusal procedure before assigning an outcome.

New evidence uses DSPy **3.4.1**, CPython **3.14.5**, Node **24.15.0**, Pyodide
**314.0.7** and scripted replies only. Local measurements use macOS; Ubuntu
24.04 CI uses Node **24.22.2** and CPython **3.14.6** for native references, with
the same DSPy/Pyodide pins. Native programs run through the real DSPy
driver; the Node lane uses one fresh Worker per scenario and the existing reload
runner. Model replies are the constant `done` answer. `M` counts model requests,
`E` counts rejected egress attempts. Every driver scenario has zero capability
requests, zero residual tasks, zero requests after termination and no pending
interaction. Node additionally asserts zero Worker errors and only fixture-origin
`/python/` requests. Neither recorder forwards I/O; every target is
`127.0.0.1:9`. No real credential is used.

| Scenario | Prediction (immutable fixture) | Native observation | Node observation |
| --- | --- | --- | --- |
| `pe-control-routed` | `done`, M1, E0, plain-DSPy parity | As predicted; output and payload parity | As predicted; output and payload parity |
| `pe-env-facts` | NumPy/FAISS/LiteLLM absent; OpenAI native only; requests/httpx both lanes | As predicted | **Diverges:** httpx absent; remaining facts match |
| `pe-lm-runtime-set` | `executor_error`, M0, E≥1 | As predicted; E1 | **Diverges:** same code, M0, E0; default socket transport |
| `pe-lm-runtime-context` | `executor_error`, M0, E≥1 | As predicted; E1 | **Diverges:** same code, M0, E0; default socket transport |
| `pe-lm-runtime-nokey` | `executor_error`, M0, E0 | As predicted | As predicted |
| `pe-lm-kwargs` | `unsupported`, M0, E0 | As predicted | As predicted |
| `pe-schema-response-format` | `unsupported`, M0, E0 | As predicted | As predicted |
| `pe-schema-typed-ok` | `done`, M1, parity, no `jsonSchema` | As predicted; E0 | As predicted; E0 |
| `pe-schema-typed-violation` | Fixed non-success after M1, no retry | `executor_error`, M1, E0 | `executor_error`, M1, E0 |
| `pe-schema-candidate-shape` | Typed object schema; open mapping `json_object` | Normalized `dict` with `type: json_schema`, inner object schema; mapping `{'type': 'json_object'}` | Unmeasured (native-only) |
| `pe-embed-hosted-string` | `executor_error`, M0, E0; missing LiteLLM | As predicted | As predicted |
| `pe-embed-callable` | `executor_error`, M0, E0; missing NumPy | As predicted | As predicted |
| `pe-embed-retriever` | `executor_error`, M0, E0; missing NumPy | As predicted | As predicted |
| `pe-retrieve-local-rm` | `['local a', 'local b']`, M0, E0 | As predicted | As predicted |
| `pe-retrieve-colbert` | `executor_error`, M0; native E≥1, Node E only if fetch reached | As predicted; E1 | `executor_error`, M0; E0 locally on macOS, E1 in Ubuntu CI; same fixed refusal and zero bridge requests |

The schema-shape probe runs plain DSPy with a scripted schema-advertising LM,
not through the galaxie driver. Its object schema is design input, not evidence
that galaxie forwards a provider constraint. Native and Node parity references
compare outputs and model payloads for the routed control and typed-literal case.

| Gap | Outcome | Deciding evidence and replacement |
| --- | --- | --- |
| Provider-string LMs | **alternative** | Existing `refused-lm` at prepare plus the three new runtime-LM probes; `pe-control-routed` and `pe-lm-kwargs` prove role mapping and host-owned model configuration on native/Node. |
| Native provider schema output | **alternative** | `pe-schema-response-format` refuses; typed success/violation and existing `json-adapter`/`parse-failure` prove Python-side validation on native/Node, without provider-constrained decoding. Mapping the router feature remains implementation work. |
| Embeddings | **refused** | All three `pe-embed-*` shapes fail in both lanes; `pe-env-facts` shows missing dependencies and no measured vector replacement. Router roles are text/decision only. |
| Service retrievers | **alternative** | `pe-retrieve-colbert` ends outside the broker; native/Node RAG regression proves host-bound `docs.search@1` plus routed generation. Local `rm` is an informational bundled-corpus control. |

Premise correction: DSPy 3.4.1 provider strings default to the native lm15 engine,
not LiteLLM. `backend_selection.select_backend` resolves `openai/gpt-4o` with
`api_base` and a fixture credential to the native `openai-chat` provider. The
lm15 router defaults to `StdlibAsyncTransport` under Pyodide too; it does not
automatically choose the available `FetchTransport`. Source inspection explains
the zero Node fetch observations for the runtime LM probes. The context probe
clears the predictor's LM inside `aforward` after prepare so the context supplies
the effective LM; otherwise
the placeholder wins and the probe measures the routed control instead.

A provider LM bound before prepare is refused, but runtime construction is outside
that validation and bypasses the router's grants, budgets and destination policy.
Native rejected connection attempts demonstrate that path. Zero Node fetch
attempts do **not** establish containment or successful fetch transport: this is
the trusted-code limit of ADR-0018 decision 9. Explicit FetchTransport,
XMLHttpRequest and real-service reachability are unmeasured. The Worker recorder
installed successfully in every scenario; absent instrumentation would have made
egress visibility unmeasured, while the fixture guard still rejects external fetch.

ColBERT differs between the measured Node environments: macOS records no fetch,
while Ubuntu CI records one rejected `127.0.0.1:9` fetch. Both end
`executor_error` with zero model/capability requests, no unexpected target and
clean termination. The exact transport difference remains unmeasured; the
observation does not establish XMLHttpRequest or real-service reachability.
The initial CI assertion wrongly required zero attempts for every scenario,
contradicting the committed ColBERT prediction. It now accepts only zero or one
rejected sentinel attempt for ColBERT while keeping every other scenario at zero
and preserving all endpoint, fixed-code, bridge and cleanup assertions. This
egress observation does not trigger the conditional refusal unit or change any
outcome. It does trigger a drafted Worker egress design follow-up under
ADR-0018 decision 9.

The environment probe also corrects a lock/closure assumption: `httpx` is in the
shared lock but not installed for DSPy. `requests` is present in both lanes;
`openai` and `httpx` are present only natively; `litellm`, `numpy` and `faiss` are
absent in both. The immutable predictions remain unchanged. Hosted embeddings
need LiteLLM; callable postprocessing needs NumPy. Adding them changes the pinned
closure. ADR-0019's retrieval Worker owns embedding and returns passages rather
than vectors; no embedding role or vector capability is established here.

| Reused evidence | Source | Lanes and treatment |
| --- | --- | --- |
| Foreign predictor LM refused at prepare | `golden-dspy/refused-lm.json`, `python/galaxie/tests/test_dspy.py` | Existing native/Node/Chromium evidence; native/Node regression rerun, no duplicate probe |
| Provider literal lint | `python/galaxie/tests/test_dspy_lint.py` | Native regression; syntax-only aid |
| Routed payloads, prompted JSON, parse failure | `golden-dspy/predict.json`, `json-adapter.json`, `parse-failure.json` | Existing native/Node/Chromium evidence; native/Node regression rerun |
| Router schemas and pydantic-ai NativeOutput | `_bridge.py`, `bridge.ts`, `adapter.ts`, `pydantic_ai.py`, ADR-0018 decision 11 | Source/matrix evidence, no DSPy schema-forwarding claim |
| Host-bound retrieval and routed answer | RAG `test_dspy_agent.py`, `dspy-agent.node.test.ts`, `dspy-conformance.node.test.ts`, `dspy-gate.node.test.ts`; `test_dspy.py` capability tool | Native/Node regression rerun; previous Chromium RAG evidence only |
| Offline state, descriptor binding, parallel and runtime | PRs #196, #213, #214, #215 | Existing native/Node suites rerun; only previously measured state/binding cases have Chromium evidence |

New Chromium, Firefox and WebKit probes are **unmeasured**. Real models/services,
other DSPy versions, `engine='litellm'`, `dspy.lm15.register_provider` declarations,
Databricks/Weaviate retrievers, vector-returning host capabilities,
undeclared-role refusal and multimodal inputs are unmeasured. No network access
beyond rejected loopback attempts is needed. Existing Chromium evidence is reused
only for the rows above; the full gate's browser regressions do not measure the
new `pe-*` family.

Reproduce from the repository root (wheel rebuild precedes Worker tests):

```sh
node scripts/build-python-wheels.ts
cd python
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest ../tests/conformance/cases-dspy/test_dspy_provider.py -q
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest ../tests/conformance/cases-dspy galaxie/tests/test_dspy.py galaxie/tests/test_dspy_gate.py galaxie/tests/test_dspy_lint.py galaxie/tests/test_dspy_state_binding.py -q
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/bin/python -m pytest ../examples/rag-browser/agent_py/tests/test_dspy_agent.py -q
cd ..
python/.venv/bin/python scripts/record-dspy-conformance.py --check
python/.venv/bin/python scripts/record-dspy-state-conformance.py --check
pnpm run typecheck:python
pnpm exec vitest run --project node tests/conformance/dspy-provider.node.test.ts
VITEST_MAX_WORKERS=4 pnpm exec vitest run --project node tests/conformance/dspy.node.test.ts tests/conformance/dspy-restore.node.test.ts tests/conformance/dspy-state.node.test.ts tests/conformance/dspy-state-restore.node.test.ts tests/conformance/dspy-state-bind.node.test.ts tests/conformance/dspy-state-limits.node.test.ts tests/conformance/dspy-parallel.node.test.ts tests/conformance/dspy-runtime.node.test.ts examples/rag-browser/test/dspy-agent.node.test.ts examples/rag-browser/test/dspy-conformance.node.test.ts examples/rag-browser/test/dspy-gate.node.test.ts
pnpm format
pnpm lint
pnpm typecheck
pnpm typecheck:ts6
pnpm run check:docs
VITEST_MAX_WORKERS=4 pnpm check
git diff --name-status main
```

Focused results: native provider 16 passed; native DSPy regression 336 passed;
native RAG 7 passed; Node provider 15 passed; existing Node/RAG suites 207 passed
and one opt-in measurement skipped. Read-only recorders pass: 38 DSPy
cases, five states and seven state cases. The initial Node package assertion
exposed the httpx prediction difference; the assertion now records the observation
without changing the fixture. No Worker refusal fix was required.
The first Ubuntu CI DSPy shard had 297 passing tests, one opt-in skip and one
failure: the overly strict ColBERT attempt assertion, not a timeout. The measured
rejected fetch is retained above rather than hidden by the correction.

### ADK stream namespace and Workflow measurements

The [fixed rule and results](../../docs/adr/0020-google-adk-through-an-adapter.md#stream-namespaces-workflow-agents-and-subgraphs-spike-2026-11)
record a message-only attribution alternative on Python and JavaScript, with
Workflow refused and subgraphs false on every executor. Native Python evidence
is in `cases-adk-python/test_adk_python_stream_namespaces.py` and
`test_adk_python_workflow_hosting.py`; executor measurements are in
`python/galaxie/tests/test_adk_stream_namespaces.py` and `test_adk_workflow_hosting.py`.
JavaScript's `stream-namespaces-native.test.ts`, `stream-namespaces-measure.test.ts`
and `workflow-hosting-native.test.ts` run on Node and Chromium. Go's
`go/galaxie/stream_namespaces_test.go` checks native identities, bridge authors,
native duplicate-name refusal and the absence of a Workflow graph in pinned sources.
These characterization tests add no golden cases, so all existing case counts,
golden bytes and restore assertions remain unchanged. New Python and Go browser
behavior, full routed Workflow replacement, Firefox, WebKit and real models are
unmeasured; the fixed-rule table distinguishes skipped gates from passes.

### ADK model, toolset and built-in tool measurements

The [pre-registered rule and measured gate table](../../docs/adr/0020-google-adk-through-an-adapter.md#string-models-toolsets-code-executors-planners-and-built-in-tools-spike-2026-11)
record model and static-toolset **ALTERNATIVE** outcomes on all three executors,
with network built-ins, code executors and planners **REFUSED**. No runtime source,
public API or stored format changes, and no golden cases are added: the existing
12 JavaScript, 39 Python and 22 Go golden cases retain their bytes and registrations.

Native Python evidence is `cases-adk-python/test_adk_python_models_toolsets_builtin.py`
(nine tests). Executor evidence is `python/galaxie/tests/test_adk_model_strings.py`
and `test_adk_toolsets_builtin_tools.py` (44 tests); the unchanged 208-test executor
suite also passes. The new JavaScript files `model-strings-native.test.ts`,
`model-strings-measure.test.ts`, `toolsets-builtin-native.test.ts` and
`toolsets-builtin-measure.test.ts` run 60 executions across Node and Chromium;
adding unchanged `validate.test.ts` gives 78. Go's `model_toolset_shapes_test.go`
and `model_toolset_internal_test.go` cover native toolsets, explicit-model parity,
provider-only tools, real refusal values, fixed-list expansion, confirmation,
interaction identity and unchanged effect scopes; `pnpm run test:go` includes race
checks and native conformance.

Two predictions changed the outcome: JavaScript's second real prepare refuses a
previously mapped shared tree, and Go's explicit-model replacement passes even
though native strings do not exist. Every converter refuses provider tool config
instead of silently dropping it. Python caches toolsets per invocation; JavaScript
expands per request. Partial support gates are recorded as such and do not establish
new-shape durability or full acceptance. No new Python/Go Worker-specific probe,
Firefox, WebKit, real model or device measurement was run. External network
toolsets and cloud/container execution remain unmeasured.

Reproduce from the repository root:

```sh
pnpm run test:python ../tests/conformance/cases-adk-python/test_adk_python_models_toolsets_builtin.py
pnpm run test:python galaxie/tests/test_adk_model_strings.py galaxie/tests/test_adk_toolsets_builtin_tools.py
pnpm exec vitest run packages/adapter-adk/test/model-strings-native.test.ts packages/adapter-adk/test/model-strings-measure.test.ts packages/adapter-adk/test/toolsets-builtin-native.test.ts packages/adapter-adk/test/toolsets-builtin-measure.test.ts
pnpm run test:go
```


## LangGraph Python tool-call replies spike

The [pre-registered rule and results](../../docs/adr/0018-python-agents-through-pyodide.md#langgraph-python-tool-call-replies-spike-2026-11)
record five **alternative** cells (binding/replies, streaming, confirmed writes,
safety floor, durability) and **refused** neighbours. No production proxy change
or new golden ships. The original `CASE_NAMES`, twelve-case counts, projections,
goldens and Chromium load budget are unchanged.

- [`test_tool_call_replies_native.py`](cases-python/test_tool_call_replies_native.py)
  has nine native CPython tests for prebuilt/manual loops, ordered messages and
  call IDs, config injection, parallel namespaces, default/explicit error handlers
  and streaming argument merge.
- [`test_langchain_tool_calls.py`](../../python/galaxie/tests/test_langchain_tool_calls.py)
  has 37 candidate/premise tests. The six terminal codes under both explicit
  handlers lose their code at the error-status history refusal; later helpers
  still cross the bridge. No permitted shared execution key was established.
- [`test_tool_call_replies_alternative.py`](cases-python/test_tool_call_replies_alternative.py)
  has four CPython text-protocol comparisons against the native tool-call oracle.
- [`pyodide-tool-calls.node.test.ts`](pyodide-tool-calls.node.test.ts) has 12 tests
  through real core and Node Pyodide: read/text-stream and ordered read/write
  replacements; host write approval/decline; fatal budget and private-result
  destination refusal; both explicit candidate error handlers; completed-node
  restore and writing-node replay with one host write; unlisted-name refusal.
  Native expected calls, final text and write counts come from CPython at test
  time, never a hand-written golden. Each long test has a 900000 ms timeout.

The helper candidate is confined to measurement files. A fresh run can succeed on
its prepared Worker after failure, but this is not proof of a latch: none was
built. Inherited shipped `bind_tools` raises `NotImplementedError` in CPython;
Worker normalization is `unavailable` at boot or `executor_error` during a run.
Native model binding and direct trusted capability calls remain outside the
candidate guard. The [author recipe](../../packages/adapter-pyodide/README.md#langgraph-python-model-chosen-calls-through-text)
uses plain JSON text and direct broker calls, retains host-confirmed write setup
and lets terminal errors escape. It supplies no ToolNode, schema-constrained
choice or streamed tool deltas, and omits the helper tool-policy flag.

New Chromium reload, Firefox, WebKit, real models, other versions and other
executors remain unmeasured. Existing Chromium coverage remains unchanged.

```sh
pnpm run test:python ../tests/conformance/cases-python/test_tool_call_replies_native.py
pnpm run test:python galaxie/tests/test_langchain_tool_calls.py
pnpm run test:python ../tests/conformance/cases-python/test_tool_call_replies_alternative.py
pnpm exec vitest run --project node tests/conformance/pyodide-tool-calls.node.test.ts --testTimeout 900000
python/.venv/bin/python -I scripts/record-python-conformance.py --check
```
