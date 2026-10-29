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

## Running the suite

- `pnpm check` runs the repository's license, lint, both TypeScript compilers, Node/Chromium tests, build and dependency checks.
- `CI=true pnpm test` runs both test projects without writing missing goldens.
- `pnpm test tests/conformance/galaxie.test.ts` runs the twelve parity cases on both galaxie lanes.

Goldens are updated only by the native Node snapshot command, `pnpm conformance:update`, when intentionally changing the baseline. Review any resulting diff. Runtime control work must leave the existing goldens and compatibility matrix unchanged.
