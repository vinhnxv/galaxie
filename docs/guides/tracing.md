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

The source records the GenAI convention pin as
`open-telemetry/semantic-conventions-genai@51a0f580f8a6ad804ca4de5e033683c6fbbe5906`,
schema URL `https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev`, with core
semantic conventions `v1.44.0`. These are source comments, not an extra revision
attribute or a schema URL supplied to `getTracer`. The conventions are Development.

| Span or outcome | Allowlisted attributes |
| --- | --- |
| Root identity | `gen_ai.operation.name`, `gen_ai.agent.name`, `galaxie.app.id`, `galaxie.agent.version`, `galaxie.instance.id`, `galaxie.session.id`, `galaxie.run.id`, `galaxie.run.segment`, `galaxie.executor.id`, `galaxie.executor.version` |
| Root settlement | `galaxie.run.status`, `galaxie.run.labels`, `galaxie.budget.name` when exhausted |
| Render outcome (`galaxie.render`, child of the paused segment's run span) | `galaxie.render.status` (`rendered` or `failed`), `galaxie.render.error.code` for a failure |
| Node | `galaxie.node.name`, `galaxie.node.step` |
| Model | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `galaxie.model.provider`, `galaxie.destination.class`, `galaxie.output_safety` when supplied |
| Capability | `gen_ai.operation.name`, `gen_ai.tool.name`, `galaxie.capability.kind`, `galaxie.destination.class` |
| Steps and failures | `galaxie.step.status`, `error.type`, `galaxie.error.code` where applicable |

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

This is a host-side example of the `WebTracerProvider` API, using host-selected
compatible OpenTelemetry packages. The repository does not install these web
SDK/exporter packages, compile this example or test a collector connection;
its tracing tests use the installed `@opentelemetry/sdk-trace` in-memory exporter.
This documentation adds no dependency.

```ts
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { createRuntime } from '@galaxie-ai/core';
import { createLangGraphAdapter } from '@galaxie-ai/adapter-langgraph';

const exporter = new OTLPTraceExporter({
  url: new URL('/otel/v1/traces', location.origin).href,
});
const provider = new WebTracerProvider({
  spanProcessors: [new BatchSpanProcessor(exporter)],
});
provider.register();
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

The host serves `/otel/v1/traces` as a proxy to its collector's OTLP/HTTP
receiver, preserving the `/v1/traces` receiver path. This is a host endpoint,
not an API galaxie provides. Configure its authentication, request limits and
origin policy in the host. A different collector origin also requires explicit
CORS and [CSP `connect-src`](host-integration.md#csp-and-trusted-types).
The browser exporter contains no Langfuse secret or authorization header.

## Forward from the collector to Langfuse

The host runs an OpenTelemetry Collector or equivalent proxy. A collector
configuration can receive OTLP/HTTP behind the host proxy and forward it:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318
exporters:
  otlphttp/langfuse:
    endpoint: ${env:LANGFUSE_OTEL_ENDPOINT}
    headers:
      Authorization: ${env:LANGFUSE_AUTH_HEADER}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/langfuse]
```

On the collector only, set `LANGFUSE_OTEL_ENDPOINT` to the chosen Langfuse
origin plus `/api/public/otel`. The OTLP/HTTP exporter appends `/v1/traces`.
Set `LANGFUSE_AUTH_HEADER` to the server-generated Basic authorization value for
the Langfuse public and secret key pair. Keep both environment values in the
host deployment; never put the secret key in browser code, Vite variables or
the bundle. Consult the linked
[Langfuse integration reference](https://langfuse.com/integrations/native/opentelemetry)
for the host's deployment. This slice records no live Langfuse result.

## Local proof

Run `pnpm test tests/conformance/trace-context.test.ts` for injected-fetch HTTP
parenting and MCP call/refresh headers on Node and Chromium. The baggage/global
propagator case runs on Node and is skipped in the browser because it needs a
global context manager at run start. These are local fixtures, with no live
collector or backend exporter measurement.

Run `pnpm test tests/conformance/tracing.test.ts` for mock-provider span trees,
failure hygiene and live-label text omission on Node and headless Chromium.
[Core tracing unit tests](../../packages/core/test/tracing.test.ts) exercise
the allowlist. `pnpm check` includes the offline documentation check; external
links are never fetched by that checker.
