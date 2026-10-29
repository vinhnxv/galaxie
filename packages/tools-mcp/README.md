# @galaxie/tools-mcp

Host-configured MCP tools as galaxie capability bindings, over Streamable HTTP with SDK 1.32.1 and protocol 2025-11-25. Only servers or gateways the host controls are supported (ADR-0011).

```ts
import { createMcpServer, toolPin } from '@galaxie/tools-mcp';

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

`id` is a lowercase namespace segment (up to 32 characters). URLs must be absolute HTTPS or loopback HTTP, with no credentials, query or fragment. `user-device` requires loopback; `in-browser` is invalid. A destination describes the final recipient, including any forwarding by a gateway. The token callback runs before each new session and before each call. Use short-lived host-issued bearer tokens: page code can read them (ADR-0012). No token is stored in a capability, event or typed error.

The host allowlists tool names, versions, kinds, pins and policies. A write must set `approval: 'confirm'`; the broker refuses it with `unsupported` until host-rendered confirmations ship. Server annotations never override the host kind. Bindings must be called through the broker for grants, labels, budgets and host-schema validation to apply.

`toolPin` hashes RFC 8785 canonical JSON for `name`, `title`, `description`, `inputSchema`, `outputSchema` and `annotations`, omitting absent fields. It rejects non-finite numbers and lone surrogates. Pins are checked on connect, on list-change notifications and against a fresh listing immediately before each call. Listings follow at most ten pages. Missing tools or changed pins prevent dispatch. Re-approve by reviewing the new metadata and configuring its new pin. Pinning detects metadata changes only; unchanged metadata can hide changed server behavior. Descriptions and annotations are never supplied to the agent or model by this package.

Each principal has a separate client/transport and a serial queue covering token acquisition, listing and dispatch. Per-principal concurrency is effectively one even if a binding allows more. Re-listing costs at least one round trip per call, plus pagination; a new session also lists on connect. HTTP 404 discards the session and retries once only for `idempotent` or `idempotency-key`. Servers must deduplicate the latter by effect ID. Failed initialization is discarded, and the complete SDK handshake, including `notifications/initialized`, follows the binding timeout and call cancellation. Cancellation sends the SDK cancellation notification; it does not prove the remote tool did nothing. Streams are not resumed.

Calls carry `galaxie.dev/agent` (`id@version`), `galaxie.dev/run` and `galaxie.dev/effect` in MCP `_meta`. Attribution is not an HTTP header and never authorizes a call. Server-to-client requests, including sampling, elicitation and roots, receive `-32601`; the client advertises no such capabilities.

Results are untrusted data. The default returns `structuredContent`; `result: 'text'` returns `{ text }` from text blocks only. `isError` fails `unavailable`; missing structured data or non-text blocks in text mode fail `invalid`. A schema-valid result can contain instruction-shaped text. It cannot grant, approve or trigger a capability: each follow-on call independently passes the broker. Hosts must render model-produced props as React text and keep server data out of diagnostic and display callbacks that interpret markup or actions.

Defaults are 262144 wire bytes per response (and per complete listing), 65536 canonical result bytes and a 30000 ms POST idle deadline. Override with finite positive integers in `limits: { messageBytes, resultBytes, idleMs }`. Wire reads stop before SDK parsing; stalled POST responses race a failure signal so the SDK's SSE error behavior cannot hold the call until its request timeout. Standalone GET notifications have no idle deadline. Limit failures return no result and emit `mcp_limit_exceeded`.

`onEvent` receives only fixed codes plus the host server/tool identifiers or protocol method. Codes are `mcp_pin_mismatch`, `mcp_tool_missing`, `mcp_protocol_mismatch`, `mcp_session_reset`, `mcp_server_request_rejected`, `mcp_limit_exceeded`, `mcp_tool_error` and `mcp_unauthorized`. All binding rejections are fresh, fixed-message core `GalaxieError`s without causes. SDK and host callback errors are discarded; this package emits no logs, spans or core diagnostics. Core's host-only `DiagnosticEvent.error` can receive the sanitized binding error, never the original SDK/server/token callback error. Hosts must avoid logging tokens or untrusted metadata/results themselves.

No OAuth, resources, prompts, third-party servers, model-chosen tool wrappers, runtime pin approval, resumable streams or host integration are included. See [the reference server](../../examples/mcp-server/README.md) and [system design](../../docs/system-design.md#61-mcp-client).
