# Unsupported features and unverified paths

Checked against the implementation on 2026-10-30; the
[MVP exit record](mvp-exit-record.md) maps acceptance requirements to existing
evidence, with the maintainer's decision pending.

## Execution and LangGraph

- Parallel interrupts, static breakpoints, ID-less interrupts and multiple interaction requests in one node are unsupported ([adapter limits](../packages/adapter-langgraph/AGENTS.md#limits)).
- Without a recovery store, a parent node's broker-bound write before an interrupting child repeats on resume. With recovery and the node config explicitly forwarded, the stable task scope replays the successful receipt: two parent bodies, one host write, including after IndexedDB reopen and restore. Call order within a task must be deterministic. Effects outside the broker still repeat; put side effects after interrupts or in a separate completed node ([parent-effect tests](../tests/conformance/subgraph-effects.test.ts), [scope and restore tests](../tests/conformance/subgraph-effect-scopes.test.ts), [AT-35](mvp-exit-record.md#acceptance-tests)).
- Implicit async LangChain context is unavailable under the synchronous shim; pass node config explicitly, and initialize real `AsyncLocalStorage` before the first prepare on Node when async ambient context is required ([context inventory and matrix](../tests/conformance/README.md#explicit-config-and-context)).
- LangGraph facades without native `transform()` or checkpoint `getState()` are unsupported ([adapter contract](system-design.md#6-core-runtime-and-contracts)).
- Framework adapters beyond LangGraph.js, universal Python execution, distributed agents, cross-device resume and always-on scheduling are outside the MVP ([scope](galaxie-project-brief.md#52-outside-the-mvp)).
- The executor runs on the main thread, with no dedicated executor-worker implementation or measured long-task result during real inference ([execution context](adr/0003-executor-execution-context.md), [M2 measurements](m2-exit-record.md#not-measured)).

## Models and providers

- Router token reservations do not set per-call provider output caps, which remain deferred even though WebLLM and OpenAI-compatible providers have their own output-limit options ([model contract](system-design.md#84-a-model-call)).
- SDK-supplied download-consent UI remains unimplemented; hosts supply consent/download interaction. Structured-output repair is disabled by default and requires host opt-in through `ModelRoute.repairAttempts`, bounded by the shared run budget. Direct provider-level repair and real-model repair rates remain outside this slice ([provider limits](system-design.md#84-a-model-call)).
- Cached WebLLM weights do not imply a loaded engine, and lazy routed construction still requires host preparation ([model guidance](../packages/models/AGENTS.md#limits), [model flow](system-design.md#84-a-model-call)).
- WebLLM resets context for every queued request rather than reusing a conversation's KV cache, and worker/device failure requires a new handle, model and runtime ([model flow](system-design.md#84-a-model-call)).
- Built-in AI is page-only, reports neither per-call token usage nor download byte size, ignores `maxTokens` and temperature, and has a browser-managed model identity that cannot be pinned ([provider contract](system-design.md#84-a-model-call)).
- A failed dispatched model call is not silently retried on another provider, and real remote-provider and localhost/LNA deployments remain unverified ([provider contract](system-design.md#84-a-model-call), [device gaps](device-matrix.md#untested-or-unmeasured)).
- OpenAI-compatible calls support text and schema output rather than tool calling, and keyless endpoints have no Authorization-removal mode ([provider contract](system-design.md#84-a-model-call)).

## UI

- Draft persistence is not provided: component-local quiz and writing drafts reset on remount or reload ([React limits](../packages/react/AGENTS.md#limits)).
- Model-produced HTML, JavaScript and event handlers are not an accepted UI format; model props render as React text through trusted registry components ([React rules](../packages/react/AGENTS.md#never)).
- LLM-composed UI, additional renderer protocols and multiple renderers are outside this MVP ([scope](galaxie-project-brief.md#52-outside-the-mvp)).
- Payments, password changes and account deletion are excluded from agent-driven interactions, and catalogs must not collect passwords or payment credentials ([mandatory baseline](galaxie-project-brief.md#97-mandatory-security-baseline-invariant-adr-0012), [React rules](../packages/react/AGENTS.md#never)).

## Storage and recovery

- There is no unknown-outcome reconciliation API: an unknown `retry: 'none'` write remains blocked on restore, and the host must reconcile with its backend by effect ID before starting a potentially repeating operation ([effect recovery](system-design.md#83-a-capability-call)).
- Recovery data is not migrated across builds. Write receipts recorded before task-scoped effect IDs are keyed by run segment, and a newer build cannot find them, so resuming such a session on a newer build can repeat a write, including a `retry: 'none'` write. No package has been released yet. Hosts must resume a session with the build that created it, or Start over and reconcile with the backend by effect ID before upgrading ([recovery contract](system-design.md#82-reload-and-crash-recovery)).
- Reload recovery cannot finish an arbitrary intermediate checkpoint with no pending interrupt or replay later writes from that point ([recovery limits](system-design.md#82-reload-and-crash-recovery)).
- The checkpoint saver's `exportSession` supplies content-free metadata by default and personal checkpoint content only with exact `personalContent: true`, which hosts must bind to an explicit user action. Host-local wires a metadata-summary download and a host-confirmed personal-content download; host-remote has no export UI. Export is lossy and supplies no import, sync, cross-device recovery or durable runtime-event history ([export semantics](../packages/storage-indexeddb/README.md#explicit-session-export), [scope](galaxie-project-brief.md#52-outside-the-mvp)).
- IndexedDB storage is not encrypted by the package and browser persistence is not permanence, so eviction can return a fresh start ([storage limits](../packages/storage-indexeddb/AGENTS.md#limits)).
- Ownership and logout need host composition, cannot fence a tab that bypasses ownership, and cannot undo an already-sent remote effect ([ownership](system-design.md#85-tab-ownership-and-takeover), [logout](system-design.md#86-logout)).

## Tools and MCP

- Third-party MCP servers and OAuth flows are unsupported; only host-controlled servers or gateways with configured principal credentials belong to this profile ([MCP scope](../packages/tools-mcp/README.md)).
- MCP resources, prompts, sampling, elicitation, roots, resumable streams and model-chosen tool wrappers are not exposed ([MCP profile](system-design.md#61-mcp-client), [client limits](../packages/tools-mcp/AGENTS.md#limits)).
- Runtime pin approval is not provided, and metadata pins detect changed definitions rather than changed behavior behind an unchanged definition ([pinning contract](../packages/tools-mcp/README.md)).
- Each principal uses one serial MCP client lane even when a binding permits greater concurrency, with a fresh listing before dispatch and no stream resumption ([client limits](../packages/tools-mcp/README.md)).
- Generic fetch, SQL and shell capabilities are not provided, and a write without the required host confirmation configuration fails `unsupported` ([broker flow](system-design.md#83-a-capability-call)).

## Security boundaries

- Trusted-first execution supplies no sandbox for arbitrary JavaScript, unreviewed agents or same-origin dependencies, which can bypass SDK-controlled paths ([trust boundary](security-review.md)).
- Data labels do not detect paraphrases sent to allowed destinations, and origin allowlists do not constrain URL paths or query content ([residual channels](security-review.md#brief-97-b-and-c-duties)).
- Manifests and digests do not provide signatures, publisher authentication or proof of safe behavior when both package and manifest can be replaced ([manifest trust model](system-design.md#62-generated-agent-manifests)).
- Client budgets and cooperative cancellation do not enforce provider billing or backend authorization ([baseline limits](security-review.md#adr-0012-baseline)).
- The output-safety hook covers routed reply text and tool-call arguments only, cannot retract already-allowed chunks, and does not cover direct models, capability results or every display callback ([output handling](security-review.md#owasp-top-10-for-llm-applications-2025)).
- Development warnings and lint rules are best-effort advice rather than runtime containment or exhaustive CSP/credential scans ([warnings](system-design.md#development-warnings), [lint limits](../packages/eslint-plugin/README.md)).

## Platforms and evidence

- Firefox, Safari, mobile devices, other GPUs and other OS/device combinations have no real-device evidence in the published matrix ([untested configurations](device-matrix.md#untested-or-unmeasured)).
- Real inference evidence is limited to the recorded Apple M5 Pro/Chrome 155 demonstrations, while automated Node and Chromium tests use fake models and engines ([device matrix](device-matrix.md)).
- Real worker-network capture, first downloads, latency distributions, main-thread long tasks, memory and the listed recovery/device measurements remain unmeasured ([MVP open items](mvp-exit-record.md#open-items-for-the-maintainers-decision)).
- The external developer trials and the pre-release legal review have no completed result in these records, and the maintainer's decision is pending ([MVP open items](mvp-exit-record.md#open-items-for-the-maintainers-decision)).
