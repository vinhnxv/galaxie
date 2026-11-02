# Conformance suite

The suite compares twelve deterministic graph cases in three lanes:

| Lane | Runtime and context | Test |
| --- | --- | --- |
| Native Node | Root `@langchain/langgraph` with native Node async context | [`native.node.test.ts`](native.node.test.ts) |
| galaxie on Node | The adapter's `/web` import with the synchronous context shim | [`galaxie.test.ts`](galaxie.test.ts), Node project |
| galaxie in Chromium | The same adapter and cases in headless Chromium, without Node polyfills | [`galaxie.test.ts`](galaxie.test.ts), Chromium project; [`browser-smoke.test.ts`](browser-smoke.test.ts) |

Only the native Node lane owns the files under [`golden/`](golden/). It normalizes generated IDs and timestamps and compares the transcript to its golden. The galaxie lanes compare normalized stream events, final state, checkpoint history, interrupts and resume against those same goldens. Both the in-memory saver and the IndexedDB saver cover `async`, `sync` and `exit` durability modes.

[`indexeddb.test.ts`](indexeddb.test.ts) reruns all twelve cases in Chromium with `@galaxie/storage-indexeddb`. It requires exactly the existing `galaxie-chromium` matrix differences; it adds no matrix lane. Each test creates and deletes its own database. `runGalaxie` accepts an optional saver factory and a `stopAtInterrupt` flag for graph-level reload tests; existing callers keep the in-memory default.

The reload tests pause `interrupt-resume`, `interrupt-subgraph` and both durability cases through the runtime, dispose it, close the saver, and rebuild the graph over a new saver on the same database and thread. The pending interrupt ID and value, `value`, `answer` and `state.next` match the original pause and goldens. Rebuilt closure counters are asserted separately: `{ prepare: 0, ask: 1 }`, or `{ callSub: 1, s1: 0, sask: 1 }` for the subgraph. The native `interrupt()` driver uses `runWithConfig` after the fixture's await under the browser shim.

**Repeated completed resume baseline (LangGraph 1.5.1, checkpoint 1.2.0):** after another close/reopen and graph rebuild, submitting the same interrupt ID again leaves the final state unchanged and emits no node updates in all four reload cases. This observes the graph's behavior after a completed resume; a persistent submission inbox, effect reconciliation and runtime/UI session adoption remain later M3 slices.

[`compatibility-matrix.json`](compatibility-matrix.json) lists an observed case/lane difference as exact JSON paths with a reason. [`galaxie.test.ts`](galaxie.test.ts) requires the computed difference set to equal the listed set: an unlisted difference or a stale listed difference fails. [`support/matrix.ts`](support/matrix.ts) validates case/lane names, unique entries and paths, and non-empty reasons. The matrix records transcript differences; it is not an API inventory.

Additional tests in this directory run on both Node and Chromium unless their filename ends in `.node.test.ts` or they are the Chromium-only `indexeddb.test.ts`. They cover runtime controls beyond transcript parity. The single guarantee-to-code-and-test map is in [system design §9](../../docs/system-design.md#9-security-baseline-map).

## Tutor portability, parent effects and credential scan

[`tutor-portability.node.test.ts`](tutor-portability.node.test.ts) covers AT-05 on Node. Both hosts declare the same workspace tutor package, alias its source entry and import its definition through the package. The test checks import specifiers and host graph construction, compares an in-memory SHA-256 entry digest and source inventory using the manifest builder's hash encoding, and checks local versus HTTP capability bindings. Vite bundles source, so the inventory covers source, package metadata and declared skills rather than the release manifest's `dist` files. Existing host loops separately execute the unchanged tutor with mocks; the optional combined runtime/node-set check is omitted because the remote host requires its browser/server harness.

[`subgraph-effects.test.ts`](subgraph-effects.test.ts) covers AT-35 separately from the twelve golden cases. A parent writes through the broker before invoking an interrupting child. On Node and Chromium, resume runs the parent body twice. With recovery and explicit node config, the full LangGraph task namespace gives both calls the same effect ID and the second call replays the successful receipt: one host write. Without recovery, host writes remain at two. [`task-scope.test.ts`](task-scope.test.ts) first verifies task identity across resume, graph reconstruction and IndexedDB reopen. [`subgraph-effect-scopes.test.ts`](subgraph-effect-scopes.test.ts) checks a fresh instance restoring the pending parent, ordinal-distinct calls in one task, a separately scoped child and later tasks of the same parent node. Chromium reopens IndexedDB; Node uses memory equivalents. Keep call order within a task deterministic and place effects outside the broker after interrupts or in separate completed nodes. See the [remaining limits](../../docs/unsupported.md#execution-and-langgraph).

[`credential-scan.test.ts`](credential-scan.test.ts) covers AT-23 on Node and Chromium. A real routed OpenAI-compatible provider uses injected fetch only, with a host callback supplying a generated canary. Two calls span a pending interaction; the second succeeds, returns 401 or throws a transport error. Both failure fixtures include the canary in their raw failure text. The canary appears in request Authorization headers and is absent from request bodies, every runtime event and observed snapshot, errors including non-enumerable message/stack fields, host diagnostics, development warnings, exported spans and generated tutor manifest/schemas. Chromium enumerates every database with `indexedDB.databases()`, every store and every key/record, decoding binary envelopes for the scan; it scans at the pause and after completion. Both lanes scan decoded checkpoints and recovery submissions; Node has no IndexedDB and uses memory storage. Positive controls check the scanner's error and byte handling.

The credential fixture uses native `nostream` and projects replies away so its events/state contain no model text; this is not SDK stream redaction. Host-only `DiagnosticEvent.error` may hold raw host exceptions on other paths and must never be forwarded to traces or public surfaces. The scan covers these fixtures and build exports, not arbitrary host code or session exports. Page code receives credentials; XSS or a malicious same-origin dependency can read them. None of these tests uses real inference, weights, the real WebLLM bundle or a real `LanguageModel` global. Goldens, cases and the compatibility matrix are unchanged.

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

[`cases-python/`](cases-python/) ports all twelve graph cases to the pinned native
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

The separate [pydantic-ai matrix](compatibility-matrix-pydantic-ai.json) lists 31
native-reference cases for model calls, tools, output validation, checked streaming
and deferred interactions. Native CPython, Node Pyodide and real headless Chromium
compare the same OpenAI-format requests, responses, capabilities, interactions and
stream projections. The CPython-only recorder uses the pinned OpenAI mapper;
provider SDKs do not enter the Worker wheel sets.

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
The built Chromium lane is
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

The separate [ADK matrix](compatibility-matrix-adk.json) lists eight cases for the `adk-js`
adapter: plain text, one and two sequential capability tool calls, an output schema with an output
key, a capability denial, an output-safety block on a function-call argument, the step budget and
abort. The reference is the pinned ADK 2.3.0 web bundle driven by its own `Runner` with a scripted
`BaseLlm` ([native lane](adk-native.node.test.ts), which writes the `golden-adk` files). The
[galaxie lane](adk.test.ts) runs the same agent through the adapter, router and broker on Node and
in headless Chromium and compares ADK-side requests, responses, capability calls, output and error
code. Call IDs are runtime-generated and are not compared. The lane is non-streaming; later
stages add streaming and pauses. It runs under the vitest browser project, not a page with the
strict mock CSP; the bundle-level strict-CSP probe lives in `packages/adapter-adk`. No other
executor's goldens or matrix change.

Run it with `pnpm exec vitest run tests/conformance/adk.test.ts tests/conformance/adk-native.node.test.ts`. To rewrite the goldens on purpose, set `ADK_UPDATE_GOLDEN=1` for the native test, run `pnpm format` and review the diff.

## Running the suite

- `pnpm check` runs the repository's license, lint, both TypeScript compilers, Node/Chromium tests, build and dependency checks.
- `CI=true pnpm test` runs both test projects without writing missing goldens.
- `pnpm test tests/conformance/galaxie.test.ts` runs the twelve parity cases on both galaxie lanes.

Goldens are updated only by the native Node snapshot command, `pnpm conformance:update`, when intentionally changing the baseline. Review any resulting diff. Runtime control work must leave the existing goldens and compatibility matrix unchanged.
