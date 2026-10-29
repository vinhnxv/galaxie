# @galaxie/tools-mcp: coding guidance

## Purpose

Bind host-allowlisted, pinned MCP tools as broker capabilities through
principal-scoped Streamable HTTP sessions. Only host-controlled servers or
gateways are supported. See the [README](README.md).

## Entry points

- `@galaxie/tools-mcp` exports `createMcpServer`, `toolPin`, server/binding/limit
  types and content-free `McpEvent` types from [src/index.ts](src/index.ts).
- There are no public subpaths; do not import the internal session implementation.

## Do

Compute a definition pin in a trusted review workflow:

```ts
import { toolPin } from '@galaxie/tools-mcp';

const pin = await toolPin({
  name: 'lesson.lookup', inputSchema: { type: 'object' },
});
```

This only hashes metadata; the host must review and store the approved pin.

- Configure server URL, final destination, tool policies and per-principal token
  callback in host code with `createMcpServer`.
- Call bindings through the broker with host-declared input/output schemas.
- Mark writes `approval: 'confirm'` and configure `CreateOptions.confirmations`.
- Call `closePrincipal` at sign-out and `close` at host shutdown.
- Treat schema-valid results as untrusted data; render model props as React text.

## Never

- Never use remote annotations as grants, binding kinds or confirmation decisions.
- Never treat a matching pin as proof of unchanged server behavior.
- Never use attribution `_meta` as authentication or authorization.
- Never send descriptions, tokens or tool results to logs or markup sinks.
- Never propagate raw SDK/server/token callback errors: binding errors are fixed
  `GalaxieError`s without causes. Core may see that sanitized error in host-only
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
