---
title: M4 MCP Client and Reference Server - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M4 MCP Client and Reference Server - Plan

## Goal Capsule

- **Objective:** ship `@galaxie/tools-mcp`, an MCP client over Streamable HTTP pinned to protocol revision 2025-11-25. It binds allowlisted, pinned MCP tools as galaxie capabilities. Alongside it, ship `examples/mcp-server`, a reference server that follows the brief's server profile.
  - The work satisfies AT-25 (allowlist, pinning, namespacing and result limits) and AT-33 (the server profile), within ADR-0011 and brief §9.5.
  - This is M4 slice 2. Host-rendered confirmations are slice 3: until then, write tools are bound with `approval: 'confirm'`, and core already refuses those calls with `unsupported`.
- **Means:**
  - a new package `packages/tools-mcp` that depends on `@galaxie/core` and `@modelcontextprotocol/sdk` 1.32.1, using client subpaths only;
  - a new example `examples/mcp-server` that uses the same SDK's server subpaths over `node:http`, without `express` or `cors`;
  - Node tests against the in-process example server;
  - conformance tests on Node and Chromium through the capability broker, with the server started by a Vitest global setup;
  - docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0011, ADR-0012, ADR-0014 and ADR-0017. Do not edit any ADR.
  3. This plan.
  4. Brief §9.5, §9.6 and AT-25/AT-33.
  5. `docs/system-design.md`.
  6. The Spike D report, `spikes/d-remote-paths/README.md`. It is evidence only: never import or copy spike code.
- **Execution profile:** autonomous and offline, in Node and headless Chromium. Work on the existing branch `m4/mcp-client` and open one pull request against `main`. Run U1 to U6 in order, with `pnpm check` after each.
- **Already done on this branch:** the plan commit includes three things.
  - `packages/tools-mcp/package.json`, which depends on `@galaxie/core` `workspace:*` and `@modelcontextprotocol/sdk` 1.32.1, with `zod` as a peer;
  - `examples/mcp-server/package.json`, which depends on `@modelcontextprotocol/sdk` 1.32.1 and `zod` 4.6.7;
  - the updated, installed root `pnpm-lock.yaml`.

  Do not change any dependency further. You may add `scripts`, and the `tsconfig.json`/`tsconfig.build.json` files that mirror `packages/storage-indexeddb`.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - an existing test assertion must change;
  - a conformance golden or the compatibility matrix would change;
  - an ADR would change;
  - a dependency or the lockfile would change again;
  - a tool description, annotation, result text or token would reach an error message, span attribute, diagnostic or log;
  - an unlisted or unpinned tool could be called;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

**Server configuration (client side)**

- R1. `createMcpServer(options)` from `@galaxie/tools-mcp` takes the following options. It validates them at construction and throws a core `GalaxieError('invalid')` when any fails:
  - `id`: the namespace segment, matching `^[a-z][a-z0-9-]{0,31}$`;
  - `url`: an absolute URL. It must use `https:`, or `http:` only on `localhost`, `127.0.0.1` or `[::1]`. It must carry no username, password, query or fragment. The same rule as the OpenAI-compatible provider.
  - `destination`: a `DestinationClass`, but not `in-browser`; `user-device` requires a loopback URL, as `httpCapability` checks.
  - `token`: `(request: { principalScope, signal }) => string | Promise<string>`, a host callback returning a short-lived bearer token. It is called before each new session and before each call; a non-string or empty value fails the call with `unavailable`.
  - `limits`: optional, all finite positive integers with defaults:
    - `messageBytes`: 262144;
    - `resultBytes`: 65536;
    - `idleMs`: 30000.
  - `fetch`: optional, for tests and custom transports.
  - `onEvent`: optional; see R12.

  Agents cannot add servers at runtime: this is host code only.
- R2. `server.bindings(tools)` returns `Record<CapabilityName, CapabilityBinding>` for the core broker. `tools` maps an MCP tool name to a host entry with these fields:
  - `version`: a positive safe integer;
  - `kind`: `'read'` or `'write'`;
  - `pin`: a lowercase SHA-256 hex string;
  - `timeoutMs`, `concurrency`, `grantScope` and `retry`, as in `CapabilityBinding`;
  - `approval`;
  - `result`: optional, `'structured'` (the default) or `'text'`.

  Each binding's capability name is `mcp.<id>.<tool>@<version>` (ADR-0011 namespacing; `CapabilityName`'s `@<n>` suffix). The host's `kind` wins over any annotation. A `write` entry must set `approval: 'confirm'`, otherwise the binding is `invalid`. A `read` entry may set `'none'`. Tools absent from the map are never callable.

  Input and output schemas are not part of the entry. The broker validates the input and output against the schemas in the agent's `CapabilityRequest`, as for every other binding. The remote `inputSchema` and `outputSchema` are used only for pinning; they never become the capability's schema.

**Pinning**

- R3. `toolPin(tool)` is exported. It computes the SHA-256 hex of the RFC 8785 (JCS) canonical JSON of `{ name, title, description, inputSchema, outputSchema, annotations }`, omitting absent fields.
  - Canonicalization rejects non-finite numbers and lone surrogates.
  - It is a small own implementation in `src/canonical.ts` and is tested against the RFC 8785 examples.
  - It uses `crypto.subtle` and is async.
- R4. The pin is checked against a fresh `tools/list`:
  - on connect;
  - on `notifications/tools/list_changed`;
  - immediately before every `tools/call`. Re-listing per call is deliberate: it is the simplest way to satisfy "before each call" without trusting a cache.

  The listing uses `client.request({ method: 'tools/list', params: { cursor } }, ListToolsResultSchema, options)` directly, never `client.listTools()`. `listTools()` compiles every listed tool's `outputSchema` with Ajv, including unlisted tools. That runs server-controlled code generation in the page, fails under a strict CSP without `'unsafe-eval'`, and lets one malformed schema disable every tool. Follow `nextCursor` to the end, with a cap of 10 pages that fails `unavailable`; the whole listing counts against `messageBytes`. Add a test that a tool with an invalid `outputSchema` does not stop allowlisted tools from working.

  A tool is callable only when it is allowlisted, present in the listing, and its pin matches. A mismatch or a missing tool fails the call with `unavailable` and emits `mcp_pin_mismatch` or `mcp_tool_missing` (R12). The call is never sent. Approval is configuration: the host re-approves by supplying the new pin, for example after showing `toolPin` output in its own UI. No runtime approval API exists in this slice.
- R5. Annotations and descriptions are never passed to the model or the agent by this package. Only the host-defined capability schema reaches the agent.

**Sessions and profile**

- R6. **One session per principal.**
  - The binding reads `context.principalScope` and uses a client and transport for that principal only. A session is never shared across principals.
  - `server.close()` closes every session. `server.closePrincipal(principalScope)` closes one; hosts call it on sign-out.
  - Each `initialize` sends no client capabilities beyond the defaults: no `sampling`, `elicitation` or `roots`.
  - Calls for one principal are serialized on that principal's session: the token callback, the fresh listing and the `tools/call` run as one critical section. Otherwise an overlapping call could attach another call's token to its own requests. The binding's `concurrency` still applies at the broker; for one principal it is effectively 1 in this slice. Record that limit in the docs.
- R7. **Protocol version.** After initialize, the negotiated protocol version must equal `2025-11-25`. Otherwise the session is closed and the call fails `unavailable` with `mcp_protocol_mismatch`. The SDK sends `MCP-Protocol-Version` on later requests; a test asserts the header on the server side.

  `Client.connect` accepts any version in `SUPPORTED_PROTOCOL_VERSIONS` without error, and `getServerVersion()` returns server info, not the protocol. Read `StreamableHTTPClientTransport.protocolVersion` after `connect()`. Test the mismatch path with an injected `fetch` that rewrites the initialize result's `protocolVersion` to `2025-06-18`, because the SDK server always echoes a supported version.
- R8. **404 session.** When a request fails with HTTP 404 for the session, the client discards that client and transport and starts a new session. That means initialize, list and pin check again.
  - The call is retried once on the new session only when its `retry` is `'idempotent'` or `'idempotency-key'`. Otherwise it fails `unavailable` with `mcp_session_reset`.
  - A second 404 fails without another retry.
- R9. **Server-to-client requests** (`sampling/createMessage`, `elicitation/create`, `roots/list` and any other method) are rejected with JSON-RPC `-32601` and emit `mcp_server_request_rejected` with the method name only. Use the SDK's fallback request handler if it exists in 1.32.1; otherwise rely on its automatic `-32601`, observe it, and record that in the pull request.
- R10. **Limits.**
  - The custom `fetch` wrapper counts response bytes while streaming and cancels the body over `messageBytes`, before the SDK parses it (Spike D).
  - An idle SSE stream with no bytes for `idleMs` is cancelled.
  - After parsing, the binding's result is checked against `resultBytes` using the byte length of its canonical JSON. Over either limit, the call fails `unavailable` with `mcp_limit_exceeded`, and nothing is returned.

  SDK behavior to design around:
  - When a POST response is an SSE stream and the wrapper errors its body, the SDK only calls `transport.onerror`. It does not reject the pending request, which would otherwise wait for a timeout. So the wrapper reports a limit or idle failure through a per-session failure signal. The binding races the SDK request against that signal; when it fires, the binding aborts the request's own `AbortController`, which also sends `notifications/cancelled`, and fails as above. A U4 test asserts that the call fails within `idleMs` plus a small margin, not at `timeoutMs`.
  - The idle timer applies only to POST response streams. The standalone GET stream, which carries `list_changed`, is not idle-limited. Construct the transport with `reconnectionOptions` set to `maxRetries: 0`, since resumable streams are out of scope; re-listing before each call covers a dropped GET stream.
  - Drive the idle test with an injected `fetch` that stalls, not with the reference server, whose keep-alive would keep the stream active.
- R11. **Calls.**
  - `tools/call` is sent with `{ name, arguments: input, _meta }`. The `_meta` carries the A8 attribution: `galaxie.dev/agent` (`<id>@<version>`), `galaxie.dev/run` and `galaxie.dev/effect` (the effect ID, which servers may use as an idempotency key). Attribution never authorizes. KTD3 explains why `_meta` is used instead of headers.
  - Calls use `client.request({ method: 'tools/call', params }, CallToolResultSchema, options)` directly, never `client.callTool()`: `callTool` validates against the server's `outputSchema` with Ajv and throws SDK errors of its own.
  - Every SDK request (initialize, `tools/list`, `tools/call`) receives `{ signal, timeout }`, with `timeout` set to the binding's `timeoutMs`. Otherwise the SDK's 60 s default would override the broker's deadline.
  - The call's `signal` is passed, so an abort sends `notifications/cancelled`, which the SDK already does.
  - A result with `isError: true` fails `unavailable` with `mcp_tool_error`.
  - With `result: 'structured'`, the binding returns `structuredContent`; a missing value fails `invalid`.
  - With `result: 'text'`, it returns `{ text }`, the concatenation of `text` content blocks; any non-text block fails `invalid`.
  - The broker then validates the output against the host's schema, as it already does.
  - **Results are untrusted server data** (brief §9.5). They cannot grant, approve or trigger other capabilities; any follow-on call goes through the broker's grants and approval on its own. A schema-valid result can still carry instruction-shaped text, and the docs must say so.
  - Every rejection from a binding is a fresh `GalaxieError` with a fixed message and no `cause`. SDK errors are never rethrown: `StreamableHTTPError` messages embed the server's response body. A test asserts this on every failure path.
- R12. **Events.** `onEvent({ code, server, tool?, method? })` uses only these fixed codes:
  - `mcp_pin_mismatch`;
  - `mcp_tool_missing`;
  - `mcp_protocol_mismatch`;
  - `mcp_session_reset`;
  - `mcp_server_request_rejected`;
  - `mcp_limit_exceeded`;
  - `mcp_tool_error`;
  - `mcp_unauthorized` (HTTP 401 or 403).

  The fields are host IDs and protocol method names only. An event never carries a description, a result, a token, an error message or a `cause`. Thrown errors are core `GalaxieError`s with fixed messages and no `cause`.

**Reference server**

- R13. `examples/mcp-server` exports `startMcpServer(options)`. It returns `{ url, port, close(), admin }`. Its options are:
  - `port`, default 0, bound to `127.0.0.1`;
  - `allowedOrigins`;
  - `verifyToken(token) => principal | undefined`.

  The server enforces brief §9.5:
  - an `Origin` check on every request, answering 403;
  - bearer authentication on every non-preflight request, answering 401;
  - `MCP-Session-Id` bound to the principal: another principal gets 403, and an unknown session gets 404;
  - CORS for allowed origins only. It allows the methods `GET`, `POST` and `DELETE`, allows the request headers `authorization`, `content-type`, `mcp-session-id`, `mcp-protocol-version` and `last-event-id`, and exposes `mcp-session-id`. Spike D found `cors` and `express` are not hoisted.

  Tools:
  - `lesson.lookup` (read), returning `structuredContent: { lessonId, title }`;
  - `progress.record` (write), a principal-scoped in-memory counter deduplicated by `_meta['galaxie.dev/effect']`;
  - `text.echo` (read), a text result, with an optional size argument for limit tests.

  `admin` is an in-process test API, never reachable over HTTP. It can:
  - change a tool's description;
  - forget all sessions;
  - make the next tool call send `sampling/createMessage` on the call's SSE stream;
  - read the last request headers seen, the counters, and the `_meta`.

  For Chromium, a Vitest global setup starts the server and provides `url` and a test token through `provide`/`inject`. The browser tests drive admin actions through Vitest browser `commands`. They are registered in the browser project config and run in Node, so no HTTP admin listener exists.

  The Chromium page origin:
  - Pin the browser project's `browser.api` to a fixed loopback port with `strictPort: true`, and derive `allowedOrigins` from it. Alternatively, read the resolved origin in the global setup.
  - Register the global setup on both the Node and browser projects, because `tests/conformance/mcp.test.ts` matches both. Declare the `ProvidedContext` keys.
  - For the bad-Origin case, start a second server instance whose `allowedOrigins` excludes the page origin; the page cannot forge `Origin`.
- R14. The example has a `README.md`: how to run it, the profile it enforces, and that it is a development reference, not a production gateway (ADR-0011 consequence). It never describes the server as secure.

**Boundaries and docs**

- R15. `scripts/check-dependencies.ts` gains these rules:
  - `packages/tools-mcp/src` may import only `@galaxie/core`, `@modelcontextprotocol/sdk/client/*`, `@modelcontextprotocol/sdk/types.js` (or the SDK's equivalent shared subpaths) and relative files, never SDK server subpaths or `node:*`;
  - `examples/mcp-server` may import SDK server and shared subpaths and `node:*`;
  - no file under `packages/*/src` or `packages/*/dist` imports `examples/*`. Tests may import the example server through a Vitest alias and tsconfig `paths`, since dependencies cannot change;
  - `@galaxie/tools-mcp` is an allowed host import where the other packages are.

  Update the system design §6 dependency rules to match.
- R16. Docs:
  - system design: the MCP client section, an AT-25/AT-33 coverage line in the §9 map, and the A8/A9 rows;
  - `packages/tools-mcp/README.md`;
  - the `AGENTS.md` and `README.md` status, by one or two sentences each.

  Limits to state:
  - re-listing costs one round trip per call;
  - pinning detects metadata changes only;
  - `_meta` attribution is not a header;
  - write tools stay unavailable until confirmations ship;
  - tokens are readable by page code (ADR-0012), so hosts should use short-lived tokens;
  - no OAuth, resources, prompts or third-party servers.

### Scope Boundaries

- **M4 slice 3:** confirmations, so MCP write tools become callable.
- **Out of scope:**
  - model-chosen tool calls, and LangChain tool wrappers for MCP;
  - resumable streams with `last-event-id` replay;
  - OAuth;
  - a runtime pin-approval API;
  - wiring MCP into the hosts.

### Assumptions

- The SDK 1.32.1 client bundles with Vite for the Chromium project. Spike D built it.
- The SDK's `StreamableHTTPClientTransport` accepts a custom `fetch` and `requestInit`, and surfaces `StreamableHTTPError` with HTTP status `404` (Spike D).

---

## Planning Contract

### Key Technical Decisions

- KTD1. **MCP tools are capability bindings,** not LangChain tools. The broker then applies grants, labels, argument shapes, budgets, timeouts, schema validation and the journal for free, and the graph decides calls (brief §9.5 default).
- KTD2. **Per-principal sessions are keyed by `context.principalScope`,** so a principal change can never reuse a session.
- KTD3. **Attribution goes in `_meta`.** The SDK transport sets headers per session, while attribution varies per call. A per-call header would need request correlation inside a custom `fetch`. `_meta` reaches the server with the call and authorizes nothing.
- KTD4. **Pins are host configuration.** A pin change needs a host decision; this slice adds no runtime approval state.

### Output Structure

- `packages/tools-mcp/{package.json,tsconfig.json,tsconfig.build.json,README.md}` and `src/{index.ts,server.ts,session.ts,canonical.ts,limits.ts,events.ts}`. The `src` split is a suggestion.
- `packages/tools-mcp/test/*.test.ts`.
- `examples/mcp-server/{tsconfig.json,tsconfig.build.json,README.md}`, `src/{index.ts,...}` and `test/server.node.test.ts`.
- `tests/conformance/mcp.test.ts`, the Vitest global setup file, and `vitest.config.ts`: the Node and browser projects include the new tests; aliases and pre-bundling as listed below.
- `tests/conformance/tsconfig.json` `paths`, if the other packages have entries.
- The root build and typecheck scripts, if they enumerate packages.
- `scripts/check-dependencies.ts`, including adding `packages/tools-mcp/dist` to its hardcoded dist loop.
- Type configuration:
  - `examples/mcp-server/tsconfig.json` and every new `test/tsconfig.json` set `"types": ["node"]`, as `tests/conformance` does. `tsconfig.base.json` sets `"types": []`, so a plain mirror cannot typecheck `node:http`.
  - Root `typecheck` and `typecheck:ts6` list `packages/tools-mcp`, `packages/tools-mcp/test`, `examples/mcp-server` and `examples/mcp-server/test`.
  - `build` lists both build configs.
- Vitest:
  - aliases for `@galaxie/tools-mcp` and `@galaxie/example-mcp-server`;
  - for Chromium pre-bundling, follow the `@langchain/openai` precedent. Alias the SDK client entry points to absolute paths under `packages/tools-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm`, then list them in `optimizeDeps.include`. The browser root, `tests/conformance`, cannot resolve the SDK itself.
- Docs.

### Implementation Constraints

- New files carry the SPDX header. Relative imports end in `.js`, type-only imports use `import type`, exported functions declare return types, and there is no `enum`.
- Every test server binds to `127.0.0.1` with port 0, or a provided port; no network beyond loopback. Tokens are generated per test run.

## Implementation Units

- **U1. Reference server and its profile tests.**
  - Build R13 and R14.
  - Node tests with raw `fetch` cover the profile:
    - a bad `Origin` answers 403;
    - a missing or invalid token answers 401;
    - a session used by another principal answers 403;
    - an unknown session answers 404;
    - preflight and CORS headers are correct;
    - `progress.record` deduplicates by effect ID.
  - Add the U1 dependency rules from R15 here as well, so `pnpm check` passes.
- **U2. Canonical JSON and pins.** R3, with tests on the RFC 8785 vectors and on each pinned field.
- **U3. Client sessions and calls.**
  - Build R1, R2, R6, R7, R8, R9, R11 and R12.
  - Node tests against the in-process server cover:
    - namespacing;
    - an unlisted tool is not bound;
    - a pin mismatch after `admin` changes a description, for each pinned field, with no call sent;
    - `list_changed`;
    - the protocol header;
    - 404 recovery with a retry only for idempotent entries;
    - sampling rejected;
    - per-principal sessions;
    - `closePrincipal`;
    - `isError`;
    - `structured` and `text` results;
    - the `_meta` attribution;
    - abort sends a cancel;
    - events carry no description, token or result text.
- **U4. Limits.** R10, with tests for a wire cap hit before parsing, an idle timeout and the canonical result cap.
- **U5. Conformance.** `tests/conformance/mcp.test.ts`, on Node and Chromium, through `createRuntime`/the broker with granted `mcp.*` capabilities:
  - AT-25: an unlisted tool is not callable, a pinned-field change disables the tool, namespacing holds, and the size limit holds;
  - AT-33: a bad-Origin 403, which in the browser is a CORS failure plus a Node-side 403 as in Spike D; 404 re-initialization; no shared sessions across principals; the protocol header; sampling rejection;
  - a write tool bound with `approval: 'confirm'` failing `unsupported`, with the server counter unchanged.
- **U6. Boundaries and docs.** The rest of R15, and R16.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Behavior kept | Every pre-existing test passes with unchanged assertions. | every unit |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr` is empty. | before the PR |
| Dependencies | `pnpm install --frozen-lockfile --offline` passes. The `dependencies`, `peerDependencies` and `devDependencies` fields and `pnpm-lock.yaml` are unchanged after the plan commit. | before the PR |

## Definition of Done

- U1 to U6 are complete.
- Only allowlisted tools with matching pins can be called, as namespaced capabilities through the broker, within size limits, one session per principal, on protocol 2025-11-25.
- The reference server enforces the §9.5 profile.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- ADR-0011, ADR-0012 (A5, A8 and A9) and ADR-0014.
- Brief §9.5, §9.6, AT-25 and AT-33.
- `packages/core/src/capabilities.ts`, `capability-broker.ts` (where `approval: 'confirm'` throws `unsupported`) and `http-capability.ts` (URL and destination validation, bounded reads).
- `spikes/d-remote-paths/README.md`: the CORS set, the bounded `fetch`, 404, sampling and bundle cost.
