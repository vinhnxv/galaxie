# ADR-0011: MCP and remote tools through servers the project controls

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related:** brief §9.5, §9.6, §16.7; ADR-0012
- **Revisions:** 2026-10-28, after an external read-only review and before any implementation:
  - corrected the authorization summary;
  - pinned protocol revision 2025-11-25;
  - added the security profile;
  - pinning described as metadata-change detection.

## Context

- Agents need tools that live on other servers: MCP servers and existing APIs.
- A browser can reach a remote MCP server directly over Streamable HTTP only when the server allows CORS and supports browser-friendly auth.
- Authorization in MCP is optional. When an HTTP server uses it, the authorization spec is based on OAuth 2.1, and clients must implement PKCE. Servers the project controls can instead accept the app session or a short-lived host-issued token. Third-party servers need the standard OAuth flow.
- Streamable HTTP servers must validate `Origin` to prevent DNS rebinding. Over the same transport, servers can send requests (sampling, elicitation) back to the client.
- Few third-party servers fit a browser client today, and OAuth tokens in a browser need their own storage and revocation design.
- MCP over `stdio` cannot run from a tab at all.
- MCP tool descriptions and annotations come from the server and can carry prompt injection.
- A tool can change after it was approved, and a server can register a tool whose name collides with another tool.

Founder decision (2026-10-28): an MCP client in the MVP over Streamable HTTP, to servers or gateways the project controls, with an allowlist and pinned tool definitions. Third-party servers with OAuth come after the MVP.

## Decision

- `packages/tools-mcp` provides an MCP client over Streamable HTTP, pinned to protocol revision 2025-11-25. A new revision needs an update to this ADR.
- The supported profile (brief §9.5):
  - The client supports tools only. It rejects server-to-client sampling, elicitation and roots requests.
  - Servers validate `Origin`, authenticate every request, bind `MCP-Session-Id` to the principal and expose the session header through CORS.
  - The client sends `MCP-Protocol-Version` and re-initializes on a 404 session.
- In the MVP it connects only to servers configured in host code that the project controls: `examples/mcp-server/` in development, or a gateway in production.
  - The browser authenticates to them with the app session or a short-lived token issued by the host backend.
  - A gateway holds third-party credentials and talks to downstream servers, including `stdio` ones.
- Per-tool allowlist: each allowed tool maps to a logical capability with a host-defined schema and kind. Unlisted tools cannot be called.
- Per-server namespace: `mcp.<server>.<tool>`.
- Definition pinning (metadata-change detection):
  - The host stores a hash of each tool's canonicalized name, title, description, input schema, output schema and annotations.
  - It is checked on connect, on `tools/list_changed` and before each call. A change disables the tool until the host approves the new definition.
  - Pinning cannot detect a change in what a tool does behind the same definition. Server authorization and result validation remain separate controls.
- Annotations (`readOnlyHint`, `destructiveHint`, …) are hints only; the host classification wins.
- Results are data, size-limited, and cannot change policy, grants or the tool set.
- Agents cannot add servers at runtime.
- Graph-driven tool calls are the default. Model-chosen tool calls need a model with tested tool calling, and write tools always need host-rendered confirmation.

## Alternatives considered

- **Defer MCP entirely.** Rejected by the founder decision; MCP is central to "tools on other servers".
- **Third-party MCP with OAuth in the MVP.** Rejected: token storage, refresh, revocation and consent UI are a separate design.
- **Expose the raw MCP tool list to the model.** Rejected: tool poisoning and shadowing.

## Consequences

- The production pattern is a gateway, and its docs must say so. Galaxie does not ship a production gateway in the MVP.
- Pin management needs a small host UX or config flow for re-approval.

## Verification

- Spike D: tool listing, pinning prototype, CORS behavior and the security profile.
- AT-25, AT-26, AT-33.
- The Phase 5 entry gate for third-party OAuth: a token design review and an update to this ADR.
