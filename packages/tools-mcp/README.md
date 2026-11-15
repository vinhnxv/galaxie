# @galaxie-ai/tools-mcp

> This package is experimental and is not published to a package registry. Its API can change in any commit without notice.

Host-configured MCP tools as galaxie capability bindings, over Streamable HTTP with SDK 1.32.1 and protocol 2025-11-25. Only servers or gateways the host controls are supported (ADR-0011).

The package root exports `buildMcpServers`, `BuildMcpServersOptions` and
`BuiltMcpServers` alongside `createMcpServer`, `toolPin` and their types. There are
no public subpaths.

```ts
import { createMcpServer, toolPin } from '@galaxie-ai/tools-mcp';

// Inspect metadata in a trusted host workflow, then store this pin in host configuration.
const pin = await toolPin(reviewedToolDefinition);
const server = createMcpServer({
  id: 'lessons',
  url: 'http://127.0.0.1:3000/mcp',
  destination: 'user-device',
  token: ({ principalScope, signal }) => getShortLivedToken(principalScope, signal),
});
const bindings = server.bindings({
  'lesson.lookup': {
    version: 1, kind: 'read', pin,
    timeoutMs: 5000, concurrency: 2, grantScope: 'principal',
    approval: 'none', retry: 'idempotent',
  },
});
// Pass bindings to runtime.create. The agent requests mcp.lessons.lesson.lookup@1
// with its own input/output schemas; remote schemas are used only for the pin.
// On sign-out:
await server.closePrincipal(principalScope);
// On host shutdown:
await server.close();
```

## Build from a host configuration

```ts
import { buildHostConfig, validateHostConfig } from '@galaxie-ai/core/config';
import { buildMcpServers } from '@galaxie-ai/tools-mcp';

const validated = validateHostConfig(document, definition, hooks, baseURL);
const mcp = buildMcpServers(validated, { onEvent });
const host = buildHostConfig(validated, mcp.bindings);
// Pass host.bindings and host.modelRouting to runtime.create.
// On sign-out:
await Promise.all(Object.values(mcp.servers).map((server) => server.closePrincipal(principalScope)));
// On host shutdown:
await Promise.all(Object.values(mcp.servers).map((server) => server.close()));
```

The synchronous builder accepts only the original validated object, resolves named
token and fetch hooks by own property and returns frozen `bindings` and `servers`
maps. It invokes no hook and performs no I/O; pins are checked when calls connect.
Every server and pinned tool still passes the existing factory checks. A failure
closes all servers already created and throws `HostConfigError` with the server
or tool JSON Pointer and original code. Its cause may be the factory's fixed-message
`GalaxieError`, never an SDK, server or host callback error; no callback runs during
building. Untyped failures become `invalid` without a cause. Paths contain document
key names, so show them only to the configuration editor.

The document has the same trust as host code. Its editor chooses URLs, pins,
destinations and which token hook runs against each URL. Hosts must bind credentials
to intended origins and authorize calls at the backend. Validation cannot establish
intended-server identity or host control of a server. The host owns lifecycle;
`closePrincipal` and `close` disconnect locally without terminating the remote
session. The builder imports core/config, bringing Zod into the tools-mcp module
graph; consumer-bundle size remains unmeasured. The [host-remote example](../../examples/host-remote/README.md) adopts HTTP/model configuration, and the [host configuration guide](../../docs/guides/host-configuration.md) also describes MCP composition. [ADR-0031](../../docs/adr/0031-declarative-host-configuration.md)
stays Proposed, and ADR-0012 guarantees are unchanged.

## Server policies and limits

`id` is a lowercase namespace segment (up to 32 characters). URLs must be absolute HTTPS or loopback HTTP, with no credentials, query or fragment. `user-device` requires loopback; `in-browser` is invalid. A destination describes the final recipient, including any forwarding by a gateway. The token callback runs before each new session and before each call. Use short-lived host-issued bearer tokens: page code can read them (ADR-0012). No token is stored in a capability, event or typed error.

The host allowlists tool names, versions, kinds, pins and policies. A write must set `approval: 'confirm'`. Configure `CreateOptions.confirmations` and mount a host-rendered prompt from a separate confirmation registry to dispatch it; without that option the broker still fails `unsupported`. See the [React confirmation wiring](../react/README.md). The registry lists the full capability name, for example `mcp.lessons.progress.record@1`, and derives display rows from the validated arguments. Server annotations never override the host kind. Bindings must be called through the broker for grants, labels, budgets and host-schema validation to apply.

`toolPin` hashes RFC 8785 canonical JSON for `name`, `title`, `description`, `inputSchema`, `outputSchema` and `annotations`, omitting absent fields. It rejects non-finite numbers and lone surrogates. Pins are checked on connect, on list-change notifications and against a fresh listing immediately before each call. Listings follow at most ten pages. Missing tools or changed pins prevent dispatch. Re-approve by reviewing the new metadata and configuring its new pin. Pinning detects metadata changes only; unchanged metadata can hide changed server behavior. Descriptions and annotations are never supplied to the agent or model by this package.

Each principal has a separate client/transport and a serial queue covering token acquisition, listing and dispatch. Per-principal concurrency is effectively one even if a binding allows more. Re-listing costs at least one round trip per call, plus pagination; a new session also lists on connect. HTTP 404 discards the session and retries once only for `idempotent` or `idempotency-key`. Servers must deduplicate the latter by effect ID. Failed initialization is discarded, and the complete SDK handshake, including `notifications/initialized`, follows the binding timeout and call cancellation. Cancellation sends the SDK cancellation notification; it does not prove the remote tool did nothing. Streams are not resumed.

Approvals bind the principal, capability, frozen canonical arguments, effect ID, host policy revision and expiry. Each authorizes one dispatch; a later call or a reload asks again unless a successful journal receipt replays without a new effect. Waiting holds no broker concurrency slot, and the binding timeout begins after approval. The host must dispose the instance on logout and takeover and should also pass those abort signals in `confirmations.signals`. Same-origin page scripts can call `respond`; this gate protects against model-controlled content. Backends must still authorize every write from verified context, never from attribution metadata. An expired or declined approval does not undo a request already sent.

Calls carry `galaxie.dev/agent` (`id@version`), `galaxie.dev/run` and `galaxie.dev/effect` in MCP `_meta`. Attribution is not an HTTP header and never authorizes a call. Server-to-client requests, including sampling, elicitation and roots, receive `-32601`; the client advertises no such capabilities.

For a host-owned backend, set `destination: 'host-server'` and
`propagateTraceContext: true` in `createMcpServer`. The default is off; non-boolean
values and an opt-in with any other destination fail `invalid`. With a valid
tracer provider, requests made during a broker tool call carry only W3C
`traceparent` and optional `tracestate`, parented to that call's `execute_tool`
span. This includes lazy initialization, listings and the standalone SSE `GET`
opened by the SDK during the first call. That stream keeps its original request
context for its whole life, so a backend span for it remains a child of the
earlier call. A later notification-driven listing and session close carry no
call context; each subsequent call uses its own span. galaxie does not inject
`baggage` or use the host's global propagator.

A cross-origin MCP server must allow `traceparent` and `tracestate` in
`Access-Control-Allow-Headers` when opting in. `host-server` is a host declaration;
galaxie does not verify ownership of the URL. Browser-supplied trace IDs are
forgeable correlation hints, never authorization, audit identity or rate-limit
keys. Backends must decide sampling themselves and must not let the browser's
sampled flag force it. Host fetch instrumentation can add trace or baggage
headers independently, outside galaxie's control. See the
[tracing guide](../../docs/guides/tracing.md#send-trace-context-to-your-backend).

The [MCP conformance tests](../../tests/conformance/mcp.test.ts) separately inject sampling and elicitation requests on the tool-call SSE stream on Node and headless Chromium. Both receive `-32601` while the tool call completes. The elicitation case also verifies that initialization advertises neither capability and that the probe text reaches no agent result, MCP event, runtime event, span, diagnostic or snapshot. This is loopback evidence with mock tools, without real inference or third-party servers.

Results are untrusted data. The default returns `structuredContent`; `result: 'text'` returns `{ text }` from text blocks only. `isError` fails `unavailable`; missing structured data or non-text blocks in text mode fail `invalid`. A schema-valid result can contain instruction-shaped text. It cannot grant, approve or trigger a capability: each follow-on call independently passes the broker. Hosts must render model-produced props as React text and keep server data out of diagnostic and display callbacks that interpret markup or actions.

Defaults are 262144 wire bytes per response (and per complete listing), 65536 canonical result bytes and a 30000 ms POST idle deadline. Override with finite positive integers in `limits: { messageBytes, resultBytes, idleMs }`. Wire reads stop before SDK parsing; stalled POST responses race a failure signal so the SDK's SSE error behavior cannot hold the call until its request timeout. Standalone GET notifications have no idle deadline. Limit failures return no result and emit `mcp_limit_exceeded`.

`onEvent` receives only fixed codes plus the host server/tool identifiers or protocol method. Codes are `mcp_pin_mismatch`, `mcp_tool_missing`, `mcp_protocol_mismatch`, `mcp_session_reset`, `mcp_server_request_rejected`, `mcp_limit_exceeded`, `mcp_tool_error` and `mcp_unauthorized`. Binding invocation rejections are fresh, fixed-message core `GalaxieError`s without causes; configuration building wraps the factory's fixed-message error as described above. SDK and host callback errors are discarded; this package emits no logs, spans or core diagnostics. Core's host-only `DiagnosticEvent.error` can receive the sanitized binding error, never the original SDK/server/token callback error. Hosts must avoid logging tokens or untrusted metadata/results themselves.

No OAuth, resources, prompts, third-party servers, model-chosen tool wrappers, runtime pin approval or resumable streams are included. See [the reference server](../../examples/mcp-server/README.md) and [system design](../../docs/system-design.md#61-mcp-client).
