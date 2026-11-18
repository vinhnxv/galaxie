# Development tracing

galaxie calls only `@opentelemetry/api`. The host registers the SDK, span
processors and exporter; galaxie ships none of those and holds no tracing
credentials. Without a registered SDK or a host-supplied `tracerProvider`, its
tracing makes no network request. See [the runtime contract](../system-design.md#6-core-runtime-and-contracts)
and [ADR-0016](../adr/0016-parity-demonstrations-and-otel-traces.md).

## Span tree and convention pin

[tracing.ts](../../packages/core/src/tracing.ts) owns span construction and
the attribute allowlist. [runtime.ts](../../packages/core/src/runtime.ts) obtains
the `@galaxie-ai/core` tracer from `RuntimeOptions.tracerProvider`, or from the
global OpenTelemetry provider. Parenting uses explicit contexts.

```text
invoke_agent <agentId>             one root per start/resume segment
  galaxie.node <nodeName>          graph nodes, including nested nodes
    chat <model>                  model call; just "chat" if no model is known
    execute_tool <capability>     broker call; just "execute_tool" if unnamed
```

Forward the node's config to `host.langchain.chatModel(role).invoke(input, config)`
and `host.capabilities.call(name, input, config)` to preserve parenting. Missing
implicit model spans under the browser context shim are a documented
[conformance difference](../../tests/conformance/README.md#explicit-config-and-context).
Nodes and capabilities use `INTERNAL` spans; model calls use `CLIENT` spans.
Each pause closes its segment with `waiting_input`; a resume opens a new root
with the same run ID and an incremented `galaxie.run.segment` starting from zero.

Core implements the root text capture in [ADR-0032](../adr/0032-development-text-on-agent-root-spans.md).
[LangGraph Python and ADK Go span coverage](../adr/0033-brokered-node-and-model-spans.md)
remains follow-up work.

The source records the GenAI convention pin as
`open-telemetry/semantic-conventions-genai@51a0f580f8a6ad804ca4de5e033683c6fbbe5906`,
schema URL `https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev`, with core
semantic conventions `v1.44.0`. These are source comments, not an extra revision
attribute or a schema URL supplied to `getTracer`. The conventions are Development.

| Span or outcome | Emitted attributes |
| --- | --- |
| Root identity | `gen_ai.operation.name`, `gen_ai.agent.name`, `galaxie.app.id`, `galaxie.agent.version`, `galaxie.instance.id`, `galaxie.session.id`, `galaxie.run.id`, `galaxie.run.segment`, `galaxie.executor.id`, `galaxie.executor.version` |
| Root settlement | `galaxie.run.status`, `galaxie.run.labels`, `galaxie.budget.name` when exhausted |
| Render outcome (`galaxie.render`, child of the paused segment's run span) | `galaxie.render.status` (`rendered` or `failed`), `galaxie.render.error.code` for a failure |
| Node | `galaxie.node.name`, `galaxie.node.step` |
| Model | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `galaxie.model.provider`, `galaxie.destination.class`, `galaxie.output_safety` when supplied |
| Capability | `gen_ai.operation.name`, `gen_ai.tool.name`, `galaxie.capability.kind`, `galaxie.destination.class` |
| Steps and failures | `galaxie.step.status`, `error.type`, `galaxie.error.code` where applicable |
| Root and model development text (opt-in, subject to live labels and destination) | `gen_ai.input.messages`, `gen_ai.output.messages` |
| Capability development text (opt-in, subject to live labels and destination) | `gen_ai.tool.call.arguments` |

Attributes are conditional: missing usage, route information or model names do
not become invented values. `error.type` is a constrained type name, never the
error message. Failed spans have `ERROR` status; cancellation leaves `UNSET`.
galaxie adds no span events, links, recorded exceptions or status descriptions.
Timing comes from span start/end timestamps. There is no model-role attribute.

Render outcomes contain no props, model text, user content or thrown error details.
Each recorded outcome is one short `galaxie.render` span, started as a child of the
paused segment's run span. A page renders a pause after that run span has closed;
a child may start after its parent ended, and no closed span is changed. A failed
outcome carries `galaxie.render.error.code`. Render failures keep the run paused in
`waiting_input`; resuming on a failed render is not supported yet.

## Attribute cardinality

Keep identifiers in traces, out of metric labels. `galaxie.instance.id`,
`galaxie.session.id` and `galaxie.run.id` have an unbounded set of values across
runs. Trace and span IDs have the same metric-cardinality problem. They are
forgeable correlation values and carry no authorization; the backend must apply
its own [authorization checks](#register-a-browser-exporter-in-the-host).

Names and versions are also open-ended: `galaxie.app.id`, `gen_ai.agent.name`,
`galaxie.agent.version`, `galaxie.executor.id`, `galaxie.executor.version`,
`galaxie.node.name`, `gen_ai.tool.name`, `gen_ai.provider.name`,
`gen_ai.request.model`, `gen_ai.response.model`, `galaxie.model.provider` and
`error.type`. Their length/character checks do not establish a small vocabulary.
Use a host-owned finite aggregation allowlist before treating any of these as
metric labels; do not promote arbitrary observed values to labels.

`galaxie.model.provider` comes from the host-owned set of provider IDs in its
model configuration, the key of its `models.providers` map. Each ID is 1 to 64
characters from `[A-Za-z0-9._-]`; galaxie does not limit how many IDs a host
defines, and the host decides which IDs, if any, are aggregation labels.

The runtime supplies bounded vocabularies for `gen_ai.operation.name`,
`galaxie.capability.kind`, `galaxie.destination.class`, `galaxie.output_safety`,
`galaxie.run.labels`, `galaxie.budget.name`, `galaxie.render.status`,
`galaxie.render.error.code`, `galaxie.run.status`, `galaxie.error.code` and
`galaxie.step.status`. These are candidates for aggregation dimensions, subject
to the host's limit on combinations; labels are a set of data classes, never
user identities. Numeric `galaxie.run.segment`, `galaxie.node.step`,
`gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` are measurements or
counters, not categorical metric labels. The three development-text attributes
contain arbitrary JSON text and must never become metric labels.

## Send trace context to your backend

Set `propagateTraceContext: true` on an `httpCapability` binding or a
`createMcpServer` configuration to send W3C `traceparent` and, when present,
`tracestate` to your backend. The option defaults to off and is allowed only
with `destination: 'host-server'`; other destinations fail with `invalid`.
Existing attribution and idempotency headers keep their meaning.

```ts
import { httpCapability } from '@galaxie-ai/core';

const lookup = httpCapability({
  url: 'https://app.example/api/lessons/{id}',
  method: 'GET',
  kind: 'read',
  destination: 'host-server',
  timeoutMs: 2000,
  concurrency: 1,
  grantScope: 'principal',
  approval: 'none',
  retry: 'idempotent',
  propagateTraceContext: true,
});
```

A tracer provider is required to create a new trace: register it globally or
pass it as `RuntimeOptions.tracerProvider`. With no provider and no valid
external parent at run start, no trace headers are added. A valid inherited
parent can still propagate through the no-op tracer. The backend extracts the
W3C context and starts its server span with that parent:

```text
invoke_agent <agentId>
  galaxie.node <nodeName>
    execute_tool <capability>
      GET /api/lessons             host backend SERVER span
```

For example, with a host-configured W3C trace-context propagator and backend
tracer provider (the host installs and configures both):

```ts
import { propagation, ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';

const backendTracer = trace.getTracer('host-backend');

async function handleLookup(
  headers: Record<string, string>,
  readLesson: () => Promise<void>,
): Promise<void> {
  const extracted = propagation.extract(ROOT_CONTEXT, headers);
  const parent = trace.getSpanContext(extracted);
  const parentContext = parent !== undefined && trace.isSpanContextValid(parent)
    ? extracted
    : ROOT_CONTEXT;
  const span = backendTracer.startSpan('GET /api/lessons', {
    kind: SpanKind.SERVER,
  }, parentContext);
  try {
    await readLesson();
  } finally {
    span.end();
  }
}
```

Configure the backend sampler to apply its own sampling policy: galaxie retains
the span's sampled flag, including `00` for a dropped trace, but a browser-supplied
flag must never force backend sampling. Browser trace IDs are forgeable
correlation hints. Never use them for authorization, audit identity or rate-limit
keys. `host-server` is the host's declaration; galaxie does not verify URL ownership.
Cross-origin backends must explicitly allow both headers; see
[host integration](host-integration.md#user-device-endpoints-and-local-network-access).

The exported `injectTraceContext(context, headers)` helper lets a custom binding
opt in at request time. It changes only `traceparent` and non-empty `tracestate`,
using the live `execute_tool` context registered by the broker for a `host-server`
binding. It overwrites a host-supplied `traceparent`, and overwrites `tracestate`
when the span has one; a host-supplied `tracestate` stays when the span has none.
Unregistered contexts and contexts whose call or run has ended change nothing.
`CapabilityContext` carries no span object. Reconcile hook contexts are not registered.

For MCP, initialization, listing and tool requests made during a call use that
call's context. A notification-driven `list_changed` refresh after settlement and
session close carry no context. The standalone SSE `GET` the SDK opens during the
first call carries that call's context for the stream's whole life: a backend
span for that stream is parented to the earlier call, even as later calls use it.

The helper does not use the global propagator and never adds `baggage`, vendor
headers or `X-Request-Id`. Host-installed fetch instrumentation or a propagator
wrapped around the page's `fetch` is outside galaxie's control and can add trace
or baggage headers to any destination. Trace context on OpenAI-compatible model
calls through a host proxy is not included; that SDK owns its fetch.

## Default filter and development text

By default, spans contain only the allowlisted metadata above. Strings must be
1–128 characters without control characters or become `_OTHER`; numeric values
must be finite. Principal scope, credentials, prompts, replies, capability
arguments and results are absent. Use content-free IDs and names in host code.
The filter covers what galaxie records, not what an exporter sends.

The optional `RuntimeOptions.developmentTraceText: { destination }` admits only
JSON-encoded `gen_ai.input.messages`, `gen_ai.output.messages` and validated
`gen_ai.tool.call.arguments`. Omit it by default. Its `destination` describes the
**final recipient**: Langfuse Cloud through a host collector is `third-party`.
Every live sticky run label must permit that class at the instant text is
recorded. If any label allows only `in-browser`, text is omitted regardless of
the declaration. Serialization failure also omits text silently. Do not widen
the data policy merely to enable tracing.

For collector fan-out, `developmentTraceText.destination` **must** be the
least-trusted class among all exporters in the pipeline: use `third-party` if
any exporter sends to a hosted service. Labels are checked against the one
declared class, not separately for each exporter.

Core records agent invocation text on the `invoke_agent` root just before
each segment ends. An initial segment that succeeds or pauses can record its
schema-validated, normalized start input. A successful segment, including a
resume, can record its accepted terminal output. Both candidates must be
nonempty strings. Resumed segments omit input, paused segments omit output,
and failed or cancelled segments omit both. Structured values, partial streams,
submissions, checkpoints and pending interactions are outside this capture.

Each root attribute is a JSON string containing a one-message array with one
`text` part. The input message has role `user` and the output message has role
`assistant`. The output omits `finish_reason`. Core checks the live labels at
settlement, including private labels from submitted text and restored data.
An unlabelled start string and every reply also carry `private-user` for this
check. If the compiled schema leaves any reachable unlabelled string branch,
an unlabelled alternative also triggers this classification. Core uses the
schema's types and literal values without rerunning string patterns or custom
refinements. With the default policy, `private-user` suppresses trace text even
for an in-browser destination.

Each complete encoded root attribute is limited to the smaller of 16 KiB and
the configured `payloadBytes`, measured in UTF-8 after JSON escaping. Core
bounds candidates before serialization and omits an oversized attribute whole.
Execution and its payload accounting use their existing limits. The host
collector owns any mapping to backend request or response fields. Backend
readback for eligible root text is unmeasured. The object-shaped graph from the
trace-sink measurements remains ineligible for root text.
Root text is whatever the agent reports at the segment boundary, and
browser-side spans can be forged by page code, so treat it as a development
aid and never as an audit record.

These opted-in messages and arguments are verbatim: agent code can put tool
results, URLs or error text inside them. They are not redacted. galaxie adds no
separate capability-result, URL, header, credential or error-message attribute.
Spans from other instrumentation, including host fetch instrumentation and
provider callbacks outside the routed path, are outside galaxie's filter.

`DiagnosticEvent.error` is a separate **host-only** evidence channel. It can
contain raw binding/host errors and private text. Never forward it to a
destination that `private-user` data may not reach, or copy it into public
errors, events, snapshots or spans. It is not content-free telemetry. See the
[security review](../security-review.md).

## Register a browser exporter in the host

This host-side example follows the corrected SDK shape used by the isolated
[Chromium spike](../../spikes/llmops-trace-sinks/README.md#chromium-page-measurements),
outside root CI. The spike ran it against a local collector; repository tracing
tests still use the in-memory exporter. This guide adds no dependency.
The lane used `@opentelemetry/sdk-trace` and resources 3.1.0, OTLP/HTTP exporter
0.301.0, API 1.10.0, Vite 8.3.4 and playwright-core 1.64.1 with headless Chromium
156.0.8078.4. Evidence:
[versions.json](../../spikes/llmops-trace-sinks/results/versions.json) `/browserLane`.

```ts
import { context, trace } from '@opentelemetry/api';
import {
  BatchSpanProcessor,
  StackContextManager,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { createRuntime } from '@galaxie-ai/core';
import { createLangGraphAdapter } from '@galaxie-ai/adapter-langgraph';

const exporter = new OTLPTraceExporter({
  url: new URL('/otel/v1/traces', location.origin).href,
});
const provider = new TracerProvider({
  spanProcessors: [new BatchSpanProcessor({ exporter })],
});
trace.setGlobalTracerProvider(provider);
context.setGlobalContextManager(new StackContextManager().enable());
const runtime = createRuntime({
  appId: 'lesson-app',
  executors: [createLangGraphAdapter()],
  tracerProvider: provider,
});
// Keep the runtime alive while the host handles runs and interactions.
// At host teardown, after disposing the runtime:
// await provider.forceFlush();
// await provider.shutdown();
```

Parenting still uses explicit contexts and forwarded graph config; the stack
context manager does not supply async browser context propagation. The previous
web/base SDK example also typechecked, built and exported one span to a scratch
stub with SDK 2.12.0 / exporter 0.301.2 and SDK 2.12.1 / exporter 0.223.2. Both
sets had unmet API peer warnings, and the `latest` web/base tags were deprecated.
Those probes did not measure galaxie graphs or backend ingestion with those
package sets. Evidence:
[browser-guide.json](../../spikes/llmops-trace-sinks/results/browser-guide.json)
`/sets` and `/findings`; the [recorded SDK differences](../../spikes/llmops-trace-sinks/README.md#guide-probe-and-differences).

The host serves `/otel/v1/traces` as a proxy, rewriting to the collector's
OTLP/HTTP `/v1/traces`. This is a host endpoint; configure its authentication,
request limits and origin policy in the host. The measured page kept CSP
`connect-src 'self'`. Direct export to the collector origin produced four
violations and zero spans in either backend during a 15-second observation
window after a successful proxied control. A different collector origin needs
explicit CORS and [CSP `connect-src`](host-integration.md#csp-and-trusted-types).
No Langfuse key, Basic value or MLflow experiment header appeared in the measured
bundle or page requests. Evidence:
[browser-evidence.json](../../spikes/llmops-trace-sinks/results/browser-evidence.json)
`/proxy`, `/csp`, `/cspControl`, `/scans` and `/credentialPositiveControls`.

For linear and interrupt/resume runs, with text off and on, Chromium produced
the same normalized backend records as Node, with no lane-specific attributes.
Browser tool-call and model-failure scenarios are unmeasured. Evidence:
[browser-linear.json](../../spikes/llmops-trace-sinks/results/browser-linear.json)
and [node-linear.json](../../spikes/llmops-trace-sinks/results/node-linear.json) `/variants`;
[browser-interrupt-resume.json](../../spikes/llmops-trace-sinks/results/browser-interrupt-resume.json)
and [node-interrupt-resume.json](../../spikes/llmops-trace-sinks/results/node-interrupt-resume.json) `/variants`;
[browser-evidence.json](../../spikes/llmops-trace-sinks/results/browser-evidence.json) `/laneSpecificAttributes`.

Page close can lose spans. With a 60-second batch delay and a 15-second backend
observation window per case, these were the sampled results. No `pagehide` or
`sendBeacon` mitigation was added; these counts make no delivery guarantee.
Evidence: [browser-close.json](../../spikes/llmops-trace-sinks/results/browser-close.json)
`/cases`; the spike's [page-close notes](../../spikes/llmops-trace-sinks/README.md#chromium-page-measurements).

| Mechanism | Auto flush on hide | Langfuse / MLflow spans | Evidence |
| --- | --- | --- | --- |
| Close without explicit flush | Off | 0 / 0 of 3 | [browser-close.json](../../spikes/llmops-trace-sinks/results/browser-close.json) `/cases/0` |
| Navigate away without explicit flush | SDK default | 3 / 3 of 3 | [browser-close.json](../../spikes/llmops-trace-sinks/results/browser-close.json) `/cases/1` |
| Explicit `forceFlush()` and `shutdown()`, then close | SDK default | 3 / 3 of 3 | [browser-close.json](../../spikes/llmops-trace-sinks/results/browser-close.json) `/cases/2` |

Page-reported run, trace and session IDs are client-supplied and forgeable.
The host backend must authorize the whole user/run/segment/trace association
before posting a score; IDs alone grant no authority. The measured endpoint
holds the key on the server, takes the user from a harness-issued cookie,
confirms the trace's own run-ID metadata and segment, binds on first report,
and rejects an association already bound to another user. Collector acceptance
precedes backend visibility, so the page must retry `404 not-confirmed` after
ingestion. Evidence:
[browser-feedback.json](../../spikes/llmops-trace-sinks/results/browser-feedback.json)
`/reports`, `/limitations` and `/scans`;
[gaps.json](../../spikes/llmops-trace-sinks/results/gaps.json), `browser-endpoint`.

| Feedback report | Measured status | Evidence |
| --- | --- | --- |
| Own confirmed association | 200 | [browser-feedback.json](../../spikes/llmops-trace-sinks/results/browser-feedback.json) `/reports/aliceSegmentOne`, `/reports/bobOwnTrace` |
| Wrong trace or segment | 404 | [browser-feedback.json](../../spikes/llmops-trace-sinks/results/browser-feedback.json) `/reports/ownedRunOtherTrace`, `/reports/wrongSegment` |
| Confirmed association owned by another user | 403, which also tells an authenticated caller that the association exists (`galaxie-jjk`) | [browser-feedback.json](../../spikes/llmops-trace-sinks/results/browser-feedback.json) `/reports/confirmedOtherOwner` |
| Missing cookie | 401 | [browser-feedback.json](../../spikes/llmops-trace-sinks/results/browser-feedback.json) `/reports/unauthenticated` |

First-report-wins is only as strong as the secrecy of the IDs: someone who
learns them first can bind them. Backend confirmation establishes consistency,
not authenticity. Bind at run start through a host-issued grant for host-side
hardening (`galaxie-jjk`). The spike's cookie and binding store are an in-memory
fixture, not an authentication design. Evidence:
[browser-feedback.json](../../spikes/llmops-trace-sinks/results/browser-feedback.json) `/limitations`.

## Forward from the collector to Langfuse

galaxie works with most OpenTelemetry-based LLMOps and MLflow workflows through
the host's OpenTelemetry integration. The measured subset is trace export from Node and
Chromium, host-side Langfuse scores, session grouping, deterministic MLflow
evaluation, and LangGraph JavaScript and ADK JavaScript span coverage. Root
input/output does not work yet (`galaxie-d53.7`); Pyodide Python and ADK Go lack
node and model spans (`galaxie-d53.8`, `galaxie-d53.9`). Evidence:
[coverage-matrix.json](../../spikes/llmops-trace-sinks/results/coverage-matrix.json)
`/rows` and `/gaps`, [feedback-scores.json](../../spikes/llmops-trace-sinks/results/feedback-scores.json)
`/segments`, [sessions.json](../../spikes/llmops-trace-sinks/results/sessions.json)
`/phases`, [mlflow-evaluation.json](../../spikes/llmops-trace-sinks/results/mlflow-evaluation.json)
`/variants`, and the [Chromium results above](#register-a-browser-exporter-in-the-host).

These results are demonstrations on one Apple M5 Pro machine (Darwin arm64),
not benchmarks, delivery guarantees or deployment recommendations
([ADR-0016](../adr/0016-parity-demonstrations-and-otel-traces.md);
[versions.json](../../spikes/llmops-trace-sinks/results/versions.json) `/machine`).
The measured Langfuse is self-hosted v4; Langfuse Cloud and other majors are
unmeasured.

| Component | Measured version and image digest | Evidence |
| --- | --- | --- |
| Langfuse web | 4.80.0; `sha256:0814758db3db8e923f733be3884e7d7a9e3afd60568d874a610d78aae47476c5` | [versions.json](../../spikes/llmops-trace-sinks/results/versions.json) `/versions/langfuse`, `/images/1` |
| Langfuse worker | 4.80.0; `sha256:da9f618dd784219aa6508ab6941c4a89c4ef6fb429fb1734c4163df3baa8f1ca` | [versions.json](../../spikes/llmops-trace-sinks/results/versions.json) `/images/0` |

The host runs an OpenTelemetry Collector or equivalent proxy. This fan-out
configuration matches the measured [collector.yaml](../../spikes/llmops-trace-sinks/collector.yaml)
except for the receiver bind, adapted here for a **directly run** collector, and one added comment.
That direct-run bind was not measured. `developmentTraceText.destination` must be
the least-trusted class among all exporters in this pipeline: use `third-party`
if either exporter goes to a hosted service. See the
[least-trusted-destination rule](#default-filter-and-development-text).

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318
processors:
  transform:
    error_mode: propagate
    trace_statements:
      - context: span
        statements:
          - set(attributes["session.id"], attributes["galaxie.session.id"]) where attributes["galaxie.session.id"] != nil
          - set(attributes["langfuse.observation.metadata.galaxie.run.id"], attributes["galaxie.run.id"]) where attributes["galaxie.run.id"] != nil
exporters:
  otlphttp/langfuse:
    endpoint: ${env:LANGFUSE_OTEL_ENDPOINT}
    headers:
      Authorization: ${env:LANGFUSE_AUTH_HEADER}
      x-langfuse-ingestion-version: "4"
  otlphttp/mlflow:
    endpoint: ${env:MLFLOW_OTEL_ENDPOINT}
    compression: none # no compression below MLflow 3.7 (vendor-stated; see the MLflow section)
    headers:
      x-mlflow-experiment-id: ${env:MLFLOW_EXPERIMENT_ID}
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [transform]
      exporters: [otlphttp/langfuse, otlphttp/mlflow]
```

The measured [collector.yaml](../../spikes/llmops-trace-sinks/collector.yaml) binds
`0.0.0.0:4318` **inside a container**, with the port published as
`127.0.0.1:4318:4318` in [compose.yaml](../../spikes/llmops-trace-sinks/compose.yaml).
A wildcard host listener was not the measured shape: the smoke check rejects
one. Evidence: [smoke.json](../../spikes/llmops-trace-sinks/results/smoke.json)
`/ports` and the spike's [services and controls](../../spikes/llmops-trace-sinks/README.md#services-and-controls).

On the collector only, set `LANGFUSE_OTEL_ENDPOINT` to the chosen Langfuse
origin plus `/api/public/otel`. The OTLP/HTTP exporter appends `/v1/traces`.
Set `LANGFUSE_AUTH_HEADER` to the server-generated Basic authorization value for
the Langfuse public and secret key pair. Keep both environment values in the
host deployment; never put the secret key in browser code, Vite variables or
the bundle. Every measured run sent `x-langfuse-ingestion-version: 4`; its
necessity is unmeasured because no run omitted it. Evidence:
[collector.yaml](../../spikes/llmops-trace-sinks/collector.yaml) `exporters.otlphttp/langfuse`
and [smoke.json](../../spikes/llmops-trace-sinks/results/smoke.json) `/readback`.

The transform copies `galaxie.session.id` to `session.id` and promotes
`galaxie.run.id` to `langfuse.observation.metadata.galaxie.run.id` only on spans
carrying those source attributes. In galaxie's tree that session copy reaches
the root; it does not populate children. Evidence:
[collector.yaml](../../spikes/llmops-trace-sinks/collector.yaml) `processors.transform.trace_statements`
and [sessions.json](../../spikes/llmops-trace-sinks/results/sessions.json) `/phases/0`.

For child grouping, the host's passive `RunTraceMap` observes root spans at
`onStart` and records run, segment, session and trace IDs without changing spans.
`SessionCopy` maintains its own trace-to-session map from roots and sets
`session.id` on each span in that trace.
These are host processors, with no galaxie API. The measured recipes keep their
maps in memory without eviction (`SessionCopy` clears only on shutdown), so a
long-lived host needs its own bounded or durable store. See the measured
[run-trace.ts](../../spikes/llmops-trace-sinks/src/run-trace.ts) and
[scores.ts](../../spikes/llmops-trace-sinks/src/scores.ts) recipes.
Root-only copying grouped three roots per session but missed six children;
the processor grouped all nine observations, with text off and on. MLflow needed
only the root mapping. Evidence:
[sessions.json](../../spikes/llmops-trace-sinks/results/sessions.json)
`/rootOnlySuffices`, `/fullyGroupedWithProcessor` and `/phases`;
[gaps.json](../../spikes/llmops-trace-sinks/results/gaps.json), `langfuse-sessions`
and `mlflow-sessions` entries.

Use the **v2 observations API** for Langfuse lookups. The smoke readback, on a
hand-made two-span trace with no galaxie runtime, found two observations with
parent links and typed attributes. For interrupt/resume,
a `stringObject` metadata filter with column `metadata`, key `galaxie.run.id`
and operator `=` returned both traces of the run, segments 0 and 1. Evidence:
[smoke.json](../../spikes/llmops-trace-sinks/results/smoke.json) `/readback/observations`
and [node-interrupt-resume.json](../../spikes/llmops-trace-sinks/results/node-interrupt-resume.json)
`/variants/0/runQuery`.

| Measured representation | Langfuse readback | Evidence |
| --- | --- | --- |
| Root / node / model / capability | `AGENT` / `SPAN` / `GENERATION` / `TOOL` | [coverage-matrix.json](../../spikes/llmops-trace-sinks/results/coverage-matrix.json) `/rows/langgraph-js/spans`, `/rows/adk-js/spans` |
| Capability name | Emitted `execute_tool lookup@1` stored as `lookup@1` | [node-tool-call.json](../../spikes/llmops-trace-sinks/results/node-tool-call.json) `/variants/0/findings/0` |
| LangGraph model usage | 2 input, 3 output, 5 total tokens | [coverage-matrix.json](../../spikes/llmops-trace-sinks/results/coverage-matrix.json) `/rows/langgraph-js/usage/langfuse` |
| Text off / on, both backends | Default runs store no prompt, reply or tool text. With `developmentTraceText`, destination `host-server` and labels `public`, model input/output appears and Langfuse moves the tool-call arguments JSON onto the tool observation's input (capability results stay absent); root input/output remains absent in both modes. | [node-linear.json](../../spikes/llmops-trace-sinks/results/node-linear.json) `/variants`, [node-tool-call.json](../../spikes/llmops-trace-sinks/results/node-tool-call.json) `/variants`, [versions.json](../../spikes/llmops-trace-sinks/results/versions.json) `/nodeHostMeasurement` |
| Model failure, both backends | Langfuse `ERROR` level and MLflow `STATUS_CODE_ERROR` on model, node and root; each has `error.type`, only the root has `galaxie.error.code`. No error-message text. | [node-model-failure.json](../../spikes/llmops-trace-sinks/results/node-model-failure.json) `/variants` |
| Credential control | A canary passed through a provider declaring `credential: true` was absent from backend readbacks and page requests. | [node-linear.json](../../spikes/llmops-trace-sinks/results/node-linear.json) `/variants/0/credentialCanaryAbsent`, `/variants/1/credentialCanaryAbsent`; [browser-evidence.json](../../spikes/llmops-trace-sinks/results/browser-evidence.json) `/scans`, `/credentialPositiveControls` |

For host feedback, map the run and segment to its own trace with `RunTraceMap`.
Before accepting page-reported IDs, apply the
[host authorization checks](#register-a-browser-exporter-in-the-host).
The measured [scores.ts](../../spikes/llmops-trace-sinks/src/scores.ts) recipe
posts an array to `/api/public/scores`, forms the score ID from trace ID and
score name, supplies an explicit timestamp, and stores the entire first payload
for unchanged retries. Accepted posts returned 202; readback used
`/api/public/v3/scores?fields=subject`. Evidence:
[feedback-scores.json](../../spikes/llmops-trace-sinks/results/feedback-scores.json)
`/reference` and `/segments`.

| Score case | Measured outcome | Evidence |
| --- | --- | --- |
| Stored-payload retry | One visible score per segment, retaining the original value and timestamp | [feedback-scores.json](../../spikes/llmops-trace-sinks/results/feedback-scores.json) `/segments`; [gaps.json](../../spikes/llmops-trace-sinks/results/gaps.json), `score-idempotency` |
| Same ID, later-day payload | One visible row with the new value; whether a second physical row exists is unmeasured | [feedback-scores.json](../../spikes/llmops-trace-sinks/results/feedback-scores.json) `/freshTimestampControl`; [gaps.json](../../spikes/llmops-trace-sinks/results/gaps.json), `score-idempotency` |
| Before trace ingestion | Score accepted before observations existed; after flush, all three observations and the unchanged score linked to the trace | [feedback-scores.json](../../spikes/llmops-trace-sinks/results/feedback-scores.json) `/beforeIngestion` |
| Unknown run or segment | Explicit `unmapped`, no POST | [feedback-scores.json](../../spikes/llmops-trace-sinks/results/feedback-scores.json) `/unmapped` |

## Forward from the collector to MLflow

MLflow 3.18.0 was measured with Node and Chromium trace export, root-based
session grouping, deterministic evaluation, and LangGraph JavaScript and ADK
JavaScript span coverage. Root request/response is still absent with text on
or off (`galaxie-d53.7`); Python and Go backend classification is unmeasured.
Evidence: [versions.json](../../spikes/llmops-trace-sinks/results/versions.json)
`/versions/mlflow`, [sessions.json](../../spikes/llmops-trace-sinks/results/sessions.json)
`/phases`, [mlflow-evaluation.json](../../spikes/llmops-trace-sinks/results/mlflow-evaluation.json)
`/variants`, [coverage-matrix.json](../../spikes/llmops-trace-sinks/results/coverage-matrix.json)
`/rows`, and the [Chromium results above](#register-a-browser-exporter-in-the-host).

The measured image is `ghcr.io/mlflow/mlflow:v3.18.0`, digest
`sha256:257204c77980b0f3450a26eb6089e487603fcdd4509529eadaf88f90669f5c13`.
Evidence: [versions.json](../../spikes/llmops-trace-sinks/results/versions.json) `/images/6`.
MLflow's documentation states that OTLP trace ingestion needs 3.6 or later and
that compressed payloads are accepted from 3.7 on, so use no compression below 3.7
([MLflow OpenTelemetry ingestion](https://www.mlflow.org/docs/latest/genai/tracing/opentelemetry/ingest/)).
These two points are **vendor-stated, not measured here**. Only 3.18.0 with `compression: none` was
run; versions 3.6 through 3.17 and gzip are unmeasured. Evidence for the measured
setting: [versions.json](../../spikes/llmops-trace-sinks/results/versions.json)
`/collectorDecision/mlflowCompression` and
[collector.yaml](../../spikes/llmops-trace-sinks/collector.yaml) `exporters.otlphttp/mlflow`.

In the [fan-out example](#forward-from-the-collector-to-langfuse),
`MLFLOW_OTEL_ENDPOINT` is the MLflow origin; the exporter appends `/v1/traces`.
Create or look up the experiment on the host and provide its ID through
`x-mlflow-experiment-id`, never browser code. The smoke readback found one trace
with two spans. Evidence:
[collector.yaml](../../spikes/llmops-trace-sinks/collector.yaml) `exporters.otlphttp/mlflow`,
[smoke.json](../../spikes/llmops-trace-sinks/results/smoke.json) `/readback/traces`
and `/readback/spans`; [browser-evidence.json](../../spikes/llmops-trace-sinks/results/browser-evidence.json)
`/scans` records no experiment header in page traffic.

| Emitted span | Measured MLflow type | Evidence |
| --- | --- | --- |
| Root | `AGENT` | [coverage-matrix.json](../../spikes/llmops-trace-sinks/results/coverage-matrix.json) `/rows/langgraph-js/spans/root/mlflow`, `/rows/adk-js/spans/root/mlflow` |
| Node | No type | [coverage-matrix.json](../../spikes/llmops-trace-sinks/results/coverage-matrix.json) `/rows/langgraph-js/spans/node/mlflow`, `/rows/adk-js/spans/node/mlflow` |
| Model | `CHAT_MODEL` | [coverage-matrix.json](../../spikes/llmops-trace-sinks/results/coverage-matrix.json) `/rows/langgraph-js/spans/model/mlflow`, `/rows/adk-js/spans/model/mlflow` |
| Capability | `TOOL`; name retained as emitted (`execute_tool lookup@1`) | [coverage-matrix.json](../../spikes/llmops-trace-sinks/results/coverage-matrix.json) `/rows/langgraph-js/spans/capability/mlflow` |

LangGraph model usage was 2 input, 3 output and 5 total tokens, matching the
emitted values ([coverage-matrix.json](../../spikes/llmops-trace-sinks/results/coverage-matrix.json)
`/rows/langgraph-js/usage/mlflow`). MLflow parsed the opted-in
`gen_ai.tool.call.arguments` JSON string into an object in the attribute and
tool input: the value survived but the attribute type changed
([node-tool-call.json](../../spikes/llmops-trace-sinks/results/node-tool-call.json)
`/variants/1/findings` and `/variants/1/backends/mlflow`).

Search sessions through `mlflow.trace.session`: two sessions returned exactly
their three traces each in every phase, using only the root session mapping.
No child processor was needed. Evidence:
[sessions.json](../../spikes/llmops-trace-sinks/results/sessions.json)
`/rootOnlySuffices/mlflow` and `/phases`.

The measured host-side [Python evaluation recipe](../../spikes/llmops-trace-sinks/python/evaluate.py)
uses this sequence, with deterministic code scorers and no model-based judge or
provider key. Evidence:
[mlflow-evaluation.json](../../spikes/llmops-trace-sinks/results/mlflow-evaluation.json)
`/scorers` and `/variants`.

```text
mlflow.search_traces: filter metadata.`mlflow.trace.session` by session
mlflow.genai.evaluate: pass the searched traces and these code scorers
  chat_usage_total
  chat_text_present
  root_io_present
```

Each text mode produced six traces, six evaluation rows and six non-null values
per scorer. Usage was 5 per trace; chat text presence followed opt-in.
Root request/response and `root_io_present` stayed empty/false in both modes
(`galaxie-d53.7`). Evidence:
[mlflow-evaluation.json](../../spikes/llmops-trace-sinks/results/mlflow-evaluation.json)
`/variants/0` and `/variants/1`; [gaps.json](../../spikes/llmops-trace-sinks/results/gaps.json),
`mlflow-root-io`. The pinned recipe's `experiment_ids` search argument still
worked but emitted a deprecation warning, as recorded in the spike's
[evaluation notes](../../spikes/llmops-trace-sinks/README.md#host-feedback-sessions-and-deterministic-evaluation).

## Use Langfuse and MLflow responsibly

Use Langfuse and MLflow as developer debugging tools: for developers and users
who want to inspect how their own app and agents work. Tell users clearly what
is traced and where it is sent. Keep development trace text off unless needed,
and check [labels and the final destination](#default-filter-and-development-text)
before enabling it. Never use these tools to track users, and do not put user identifiers in
`session.id` or run IDs.

## Limits and unmeasured items

- Results demonstrate sampled deliveries on one machine. Trace-export retries,
  delivery guarantees, capacity, sustained operation, latency and failure recovery
  are unmeasured. Score-payload retries above are a separate measured workflow.
  Evidence for scope: [coverage-matrix.json](../../spikes/llmops-trace-sinks/results/coverage-matrix.json)
  `/notMeasured` and the spike's [feedback limits](../../spikes/llmops-trace-sinks/README.md#host-feedback-sessions-and-deterministic-evaluation).
- Langfuse Cloud, other Langfuse majors, MLflow versions 3.6 through 3.17, gzip,
  ingestion-header necessity, physical score-row storage and Langfuse/MLflow web
  UI views are unmeasured. The MLflow floor and compression rule are vendor-stated,
  not measured here. See the evidence and qualifications in the
  [Langfuse](#forward-from-the-collector-to-langfuse) and
  [MLflow](#forward-from-the-collector-to-mlflow) sections.
- Root input/output remains absent in both backends, even with opted-in model
  text (`galaxie-d53.7`). Evidence:
  [node-linear.json](../../spikes/llmops-trace-sinks/results/node-linear.json) `/variants`,
  [mlflow-evaluation.json](../../spikes/llmops-trace-sinks/results/mlflow-evaluation.json)
  `/variants`, [gaps.json](../../spikes/llmops-trace-sinks/results/gaps.json), `mlflow-root-io`.
- LangGraph Python in Pyodide and ADK Go emitted root and capability spans but
  no node or model spans; these were in-memory measurements, not backend runs
  (`galaxie-d53.8`, `galaxie-d53.9`). ADK Python, DSPy and Pydantic AI drivers
  are unmeasured here. Evidence:
  [coverage-matrix.json](../../spikes/llmops-trace-sinks/results/coverage-matrix.json)
  `/rows/pyodide-langgraph-python`, `/rows/adk-go`, `/gaps`, `/notMeasured`.
- ADK's own instrumentation is outside galaxie's allowlist. The measured run set
  `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false`; its five ADK spans formed five
  separate traces with empty attributes. They fall in the spike's `other` bucket
(no galaxie span kind); Langfuse stores them as `SPAN` and MLflow assigns no type. In-memory
  controls with a Node context manager detected prompt, reply, argument and result
  text with capture on, and no markers with capture off. Empty measured attributes
  alone do not prove the flag's effect. ADK nesting needs a host context manager;
  nesting with one is unmeasured here. Evidence:
  [coverage-matrix.json](../../spikes/llmops-trace-sinks/results/coverage-matrix.json)
  `/rows/adk-js/controls/captureMessageContent`, `/rows/adk-js-own-spans`;
  [control details](../../spikes/llmops-trace-sinks/README.md#span-coverage-per-executor-family).
- Browser backend ingestion was measured only on Chromium, only for linear and
  interrupt/resume scenarios. Tool-call and model-failure scenarios, Firefox,
  WebKit, real devices, real models/prompts and answer quality are unmeasured in
  this spike. Page-close loss is recorded [above](#register-a-browser-exporter-in-the-host).
  Evidence: [browser-guide.json](../../spikes/llmops-trace-sinks/results/browser-guide.json)
  `/notMeasured`, [browser-close.json](../../spikes/llmops-trace-sinks/results/browser-close.json)
  `/cases`, and the spike's [Chromium scope](../../spikes/llmops-trace-sinks/README.md#repeat-and-limits).
- Vendor telemetry stayed at defaults; its payloads and all container egress are
  unmeasured. Real user authentication, durable run/trace bindings and durable
  score-payload storage are unmeasured. Evidence:
  [versions.json](../../spikes/llmops-trace-sinks/results/versions.json) `/telemetry`,
  [browser-feedback.json](../../spikes/llmops-trace-sinks/results/browser-feedback.json)
  `/limitations`, and the spike's [feedback limits](../../spikes/llmops-trace-sinks/README.md#host-feedback-sessions-and-deterministic-evaluation).

## Local proof

Run `pnpm test tests/conformance/trace-context.test.ts` for injected-fetch HTTP
parenting and MCP call/refresh headers on Node and Chromium. The baggage/global
propagator case runs on Node and is skipped in the browser because it needs a
global context manager at run start. These repository tests use local fixtures;
the separate live collector/backend measurements are recorded in the
[spike README](../../spikes/llmops-trace-sinks/README.md) and its committed
[results](../../spikes/llmops-trace-sinks/results).

Run `pnpm test tests/conformance/tracing.test.ts` for mock-provider span trees,
failure hygiene and live-label text omission on Node and headless Chromium.
[Core tracing unit tests](../../packages/core/test/tracing.test.ts) exercise
the allowlist. `pnpm check` includes the offline documentation check. It compares this table's
attribute column with the `ALLOWED` metadata set and the `text()` helper's key
type in core's `tracing.ts`, using the installed TypeScript 6 parser. Missing
and unknown keys fail with their names; unknown keys also identify the table
row. Span names, value examples and unrelated prose are excluded. The
checker also rejects literal `setAttribute` and `setAttributes` writes that
bypass the metadata and development-text inventories, and validates source-link
`#L<n>` fragments and inclusive `#L<n>-L<m>` ranges against the target's lines. The
[documentation-check tests](../../tests/conformance/check-docs.node.test.ts)
mutate temporary source and guide copies to prove both directions of drift.
External links are never fetched by that checker.
