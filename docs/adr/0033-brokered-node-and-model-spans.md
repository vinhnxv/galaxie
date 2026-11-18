# ADR-0033: Node and model spans at brokered executor boundaries

- **Status:** Proposed
- **Date:** 2026-11-18
- **Related:** brief §7.5 and §14.4, [ADR-0012](0012-security-baseline.md), [ADR-0014](0014-data-labels-and-argument-shapes.md), [ADR-0016](0016-parity-demonstrations-and-otel-traces.md), [ADR-0017](0017-framework-neutral-contracts.md), [ADR-0018](0018-python-agents-through-pyodide.md), [ADR-0023](0023-google-adk-go-through-a-wasm-worker.md), `galaxie-d53.8`, `galaxie-d53.9`

## Context

In the scripted coverage scenarios, LangGraph Python in Pyodide completed one
model call and one capability call. ADK Go completed two model calls and one
capability call. Each executor emitted one `invoke_agent` and one
`execute_tool` span, with zero node and model spans. The call counts and correct
outputs were checked in both cases. The Go transcript also matched its golden.
The LangGraph.js and ADK JavaScript controls recorded all four span kinds.
See [coverage-matrix.json](../../spikes/llmops-trace-sinks/results/coverage-matrix.json)
`/rows/pyodide-langgraph-python/spans/node`,
`/rows/pyodide-langgraph-python/spans/model`, `/rows/adk-go/spans/node` and
`/rows/adk-go/spans/model`. The two rows' `controls`, `/rows/langgraph-js/spans`,
`/rows/adk-js/spans`, `/gaps/0` and `/gaps/1` record the controls and gaps.

The host already brokers model requests and validates replies and usage in both
families. Pyodide receives LangGraph updates and some message metadata, which
can identify a node but do not bracket its lifetime or identify every call's
parent. The Go host's stream updates describe tool calls, tool results and
pauses. Its model bridge has an author only for streamed calls. Those signals
cannot establish an ADK agent-step lifetime. See the
[Pyodide host](../../packages/adapter-pyodide/src/adapter.ts),
[Python worker](../../packages/adapter-pyodide/src/worker.ts),
[Go host model path](../../packages/adapter-go/src/llm.ts), and
[Go stream markers](../../packages/adapter-go/src/stream.ts).

## Decision

Emit both families' spans on the host side through the existing data-only
[`RunTrace`](../../packages/core/src/trace.ts) on `RunRequest`. The host owns
OpenTelemetry and span handles. The LangGraph.js
[trace handler](../../packages/adapter-langgraph/src/trace-handler.ts) is the
reference for explicit parenting and settlement. Map Python or Go lifecycle
signals to the same node and model vocabulary, with no new trace attribute,
data label or exporter dependency.

- **Nodes.** Use paired lifecycle notifications from the worker integration
  for observable LangGraph tasks and ADK agent steps. Send only a bounded,
  run-local execution ID, optional parent ID and ordinal, a declared node or
  agent name on start, and a fixed outcome on end. Use framework-declared names
  from reviewed code and the existing name filter. Emit `galaxie.node.name`
  and, when a trustworthy ordinal exists, `galaxie.node.step`. The host stamps
  receipt times.
  Ignore incomplete or ambiguous identity when choosing a parent, and omit
  spans for steps with no start signal. Stream chunk authors, tool markers,
  completion-only updates, raw paths and model roles cannot supply a missing
  node lifetime. Older bridges without lifecycle signals retain model coverage
  under the root.
- **Models.** Start one `chat` span per dispatched brokered call once the host
  has selected the route. Use a live node handle as parent only when the call
  carries an explicit link to that exact step in the same segment. Otherwise
  use the segment root. Record `gen_ai.operation.name`, `gen_ai.provider.name`,
  `gen_ai.request.model`, `gen_ai.response.model`, `galaxie.model.provider`,
  `galaxie.destination.class` and `galaxie.output_safety` through the existing
  filter, using observed model and provider metadata and the public fields of
  the host route. Existing conventions handle absent metadata. The route's
  destination describes the model call. The trace-text destination is checked
  separately. Take `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`
  from each successful, validated host response, including a final assembled
  streamed response. Omit missing usage. Reservations and intermediate chunk
  counts are outside these attributes.
- **Settlement.** Close spans once with `galaxie.step.status` and a fixed
  `error.type` on failure. A pause ends the observed node's work for that
  segment, and resumed work receives new trace handles. Core closes open
  handles when the segment settles, including cancellation. Ignore stale and
  duplicate lifecycle notifications, bound correlation state and release it on
  settlement. Trace signals leave lease settlement, output checks, capability
  policy and existing public stream events unchanged.
- **Text.** Node spans contain metadata only. For model text, when
  `RunTrace.recordsText` is true, offer a projection of validated model-request
  message text and the final reply after validation and output checks. Pass
  neither worker or provider envelopes nor credentials, tool arguments, tool
  results or errors to the trace recorder. Core alone admits
  `gen_ai.input.messages` and `gen_ai.output.messages` via the existing
  `developmentTraceText` path. The default omits text. At each write the core
  checks the live sticky labels with `inBrowserOnly` and `labelsAllow`, including
  submitted text and restored data. Every live label must allow the host's
  declared final trace destination. Browser-only labels suppress text even
  for a local destination. A host collector that forwards to a hosted service
  uses `third-party` even if the model runs locally. The host declares the
  least-trusted final destination for collector fan-out. These checks preserve
  ADR-0012 A4.

The capability broker still emits capability spans. Backend classification and
any mapping to vendor fields stay with the host collector.

## Alternatives considered

- **Emit at the adapter boundary.** Chosen because that boundary has the
  dispatched request, accepted reply and usage, and can use explicit step
  notifications when the framework provides them.
- **Infer node spans from current updates or model calls.** An update may
  arrive after a step ended, and concurrent steps can overlap. A model or tool
  call can be timed independently, but its arrival says nothing about the start
  of the owning node. Such inference would make timing and parentage ambiguous.
- **Keep only root and capability spans.** This preserves the measured trees
  but leaves brokered model activity and token usage missing. The host already
  has the per-call evidence needed to fill that gap.

## Consequences

Both adapters share the same trace boundary. Node coverage depends on each
framework's lifecycle hooks and the negotiated worker protocol. Unknown inner
nodes and older worker builds can yield a shallower tree. The measured Python
and Go rows used an in-memory exporter only. Backend classification and usage
readback in Langfuse and MLflow, timing overhead, and coverage outside the
scripted cases remain unmeasured. See
[coverage-matrix.json](../../spikes/llmops-trace-sinks/results/coverage-matrix.json)
`/notMeasured`.

## Verification

**Follow-up — Trace brokered LangGraph Python nodes and model calls.** Connect
content-free LangGraph task lifecycle signals in Pyodide to host `RunTrace`
handles and instrument the host model lease path. Test in-memory span counts,
timing and parentage, explicit correlation under concurrency, fallback to the
root, and validated usage on both invoke and stream. Cover pauses and resumes,
failures, cancellation, stale or duplicate signals, and default and live-label
text omissions with credential canaries. Preserve Python outputs and public
stream behavior.

**Follow-up — Trace brokered ADK Go agent steps and model calls.** Connect
content-free ADK agent lifecycle signals through a compatible Go bridge and
instrument `serveModel`. Test the two model spans and one capability span in
the existing tool scenario, exact per-response usage and optional parenting to
the observed agent step. Cover invoke and stream, an older worker with root
fallback, concurrency, pauses and resumes, failures, cancellation, stale or
duplicate signals, and opt-in and live-label text controls with credential
canaries. Keep the capability span and golden transcript intact. Each follow-up
can confirm emission with an in-memory exporter. Record separate backend
readback before claiming Langfuse or MLflow classification for either family.
