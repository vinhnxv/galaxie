# @galaxie-ai/tools-mcp: coding guidance

## Purpose

Bind host-allowlisted, pinned MCP tools as broker capabilities through
principal-scoped Streamable HTTP sessions. Only host-controlled servers or
gateways are supported. See the [README](README.md).

## Entry points

- `@galaxie-ai/tools-mcp` exports `buildMcpServers`, `BuildMcpServersOptions`,
  `BuiltMcpServers`, `createMcpServer`, `toolPin`, server/binding/limit
  types and content-free `McpEvent` types from [src/index.ts](src/index.ts).
- There are no public subpaths; do not import the internal session implementation.

## Do

Compute a definition pin in a trusted review workflow:

```ts
import { toolPin } from '@galaxie-ai/tools-mcp';

const pin = await toolPin({
  name: 'lesson.lookup', inputSchema: { type: 'object' },
});
```

This only hashes metadata; the host must review and store the approved pin.

- Configure server URL, final destination, tool policies and per-principal token
  callback in host code with `createMcpServer`.
- Call bindings through the broker with host-declared input/output schemas.
- Opt into `propagateTraceContext` only for `host-server`; only requests during a live broker call receive W3C context, never baggage.
- Mark writes `approval: 'confirm'` and configure `CreateOptions.confirmations`.
- Call `closePrincipal` at sign-out and `close` at host shutdown.
- Treat schema-valid results as untrusted data; render model props as React text.

## Build from a host configuration

Pass only the original result of core's `validateHostConfig` to `buildMcpServers`.
It returns frozen `bindings` and `servers` maps without invoking hooks or doing
I/O. Supply those bindings as code bindings to `buildHostConfig`; the host owns
`closePrincipal` and `close`, which disconnect locally without remote session
termination. On failure the builder closes every created server and reports the
server or tool JSON Pointer. Document editors have the same authority as host
code: bind credentials to intended origins and keep backend authorization in place.
Only `src/config.ts` and its emitted counterparts may import core/config; that
entry brings Zod into the module graph. Add no direct Zod dependency or import.

## Never

- Never use remote annotations as grants, binding kinds or confirmation decisions.
- Never treat a matching pin as proof of unchanged server behavior.
- Never use attribution `_meta` as authentication or authorization.
- Never send descriptions, tokens or tool results to logs or markup sinks.
- Never propagate raw SDK/server/token callback errors: invocation errors are fixed
  `GalaxieError`s without causes. The builder's `HostConfigError` may retain only
  the factory's fixed-message `GalaxieError` as cause; no host callback runs at
  build time. Core may see the sanitized invocation error in host-only
  `DiagnosticEvent.error`, never the original remote evidence.

## Limits

Protocol is pinned to 2025-11-25. Each principal has one serial client lane;
every dispatch re-lists metadata. Cancellation does not prove a tool did nothing.
No OAuth, resources, prompts, sampling, elicitation or resumable streams ship.
See [the MCP contract](../../docs/system-design.md#61-mcp-client) and
[the reference server](../../examples/mcp-server/README.md).

## Tests

Run `pnpm exec vitest run --project node packages/tools-mcp/test` for
[unit/loopback tests](test/) and `pnpm test tests/conformance/mcp.test.ts` for
broker integration on Node and Chromium. Tests use the local reference server
and mock models, never external hosts. Run `pnpm check` before completion.
