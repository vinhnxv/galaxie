# Development tracing

galaxie calls only `@opentelemetry/api`. The host registers the SDK, span
processors and exporter; galaxie ships none of those and holds no tracing
credentials. Without a registered SDK or a host-supplied `tracerProvider`, its
tracing makes no network request. See [the runtime contract](../system-design.md#6-core-runtime-and-contracts)
and [ADR-0016](../adr/0016-parity-demonstrations-and-otel-traces.md).

## Span tree and convention pin

[tracing.ts](../../packages/core/src/tracing.ts) owns span construction and
the attribute allowlist. [runtime.ts](../../packages/core/src/runtime.ts) obtains
the `@galaxie/core` tracer from `RuntimeOptions.tracerProvider`, or from the
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
| Node | `galaxie.node.name`, `galaxie.node.step` |
| Model | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `galaxie.model.provider`, `galaxie.destination.class`, `galaxie.output_safety` when supplied |
| Capability | `gen_ai.operation.name`, `gen_ai.tool.name`, `galaxie.capability.kind`, `galaxie.destination.class` |
| Steps and failures | `galaxie.step.status`, `error.type`, `galaxie.error.code` where applicable |

Attributes are conditional: missing usage, route information or model names do
not become invented values. `error.type` is a constrained type name, never the
error message. Failed spans have `ERROR` status; cancellation leaves `UNSET`.
galaxie adds no span events, links, recorded exceptions or status descriptions.
Timing comes from span start/end timestamps. There is no model-role attribute.

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
import { createRuntime } from '@galaxie/core';
import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';

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

Run `pnpm test tests/conformance/tracing.test.ts` for mock-provider span trees,
failure hygiene and live-label text omission on Node and headless Chromium.
[Core tracing unit tests](../../packages/core/test/tracing.test.ts) exercise
the allowlist. `pnpm check` includes the offline documentation check; external
links are never fetched by that checker.
