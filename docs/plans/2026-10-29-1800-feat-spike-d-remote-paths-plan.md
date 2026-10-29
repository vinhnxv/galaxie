---
title: Spike D Remote Paths and MCP - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Spike D Remote Paths and MCP - Plan

## Goal Capsule

- **Objective:** answer the Spike D questions in brief §16.2 before M4 starts.
  1. How does a browser page on one origin use LangChain's `ChatOpenAI` through a host proxy and through a user endpoint on another origin? This covers CORS, preflight, streaming, abort, errors and a per-call credential callback.
  2. How does an MCP client over Streamable HTTP behave against a CORS-enabled test server? This covers tool listing, pinning, the §9.5 profile (`Origin` rejection, session headers through CORS, 404 re-initialization, rejected server-to-client requests) and result size limits.

  The localhost/Ollama path with Chrome Local Network Access is out of scope; the report must say it was not tested.
- **Means:**
  - throwaway code in `spikes/d-remote-paths/`, its own pnpm workspace. `package.json`, `pnpm-workspace.yaml` and `pnpm-lock.yaml` are committed on this branch with this plan, and `node_modules` is installed;
  - Node servers for a mock OpenAI-compatible upstream, a host proxy and an MCP test server;
  - a Vite page;
  - a Playwright `record` script that drives headless Chromium and writes `results/*.json`;
  - `README.md` as the report.
- **Authority, highest first:**
  1. `AGENTS.md`. Spike code stays out of `packages/`, is never imported by package code, and never imports `packages/*` source.
  2. Accepted ADRs, in particular ADR-0012 and ADR-0016. ADR-0006 and ADR-0011 are the ADRs this spike informs. Do not edit any ADR; the report proposes changes.
  3. This plan.
  4. Brief §8.4, §9.5, §9.7 and §16.2.
- **Execution profile:** autonomous, in Node 24 and headless Chromium through the spike's own Playwright 1.64.1. Work offline with the installed `node_modules`. Work on the existing branch `spike/d-remote-paths`, and open one pull request against `main`.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - a dependency outside the committed spike lockfile is needed;
  - the root lockfile, `packages/`, `examples/`, `tests/` or `docs/adr/` would change;
  - a real provider API key or network access beyond `127.0.0.1` would be needed;
  - headless Chromium cannot run the record script after three focused attempts.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

**Topology.** Every server binds to `127.0.0.1` on a separate port, so the page and each server are distinct origins:

- the page on `:4180` (Vite);
- the host proxy on `:4181`;
- the mock OpenAI-compatible upstream on `:4182`;
- the MCP server on `:4183`.

The ports may change if they are taken; record the ones used.

**Remote model paths**

- R1. **Mock upstream.**
  - It implements `POST /v1/chat/completions`, non-streaming and SSE streaming with `stream_options.include_usage`, and returns deterministic text and usage.
  - It has a mode that accepts a `response_format` `json_schema` and returns schema-valid JSON.
  - It has an error mode for 401, 429 and 500, and a slow-stream mode for abort tests.
  - It requires `Authorization: Bearer <token>` and records, per request, the headers it saw, with the token redacted to its length, so the report can show what crossed each hop.
- R2. **Host proxy mode.**
  - The page asks the proxy's `POST /token` for a short-lived token (a random value, a 60 s expiry, one origin). Its CORS allows only the page origin.
  - Two credential shapes are probed and reported separately:
    - **prefetch:** the page fetches a token, then constructs `ChatOpenAI({ model, configuration: { baseURL: <proxy>/v1, dangerouslyAllowBrowser: true }, apiKey: <token> })` for that call;
    - **supplier:** if the installed `@langchain/openai` or `openai` SDK accepts a function or async supplier for the API key, pass one and record whether and when it is invoked (per request, per retry, per instance). If neither accepts one, record that, citing the type declaration.
  - The proxy validates the token, the `Origin`, the method and the path allowlist (`/v1/chat/completions` only). It strips the browser token and forwards with its own upstream key from an in-process constant, never sent to the page.

  Observe and record:
  - whether a preflight happens, and with which `Access-Control-Request-Headers`; record which headers the OpenAI SDK adds (for example `x-stainless-*`) that the proxy must allow;
  - streaming through CORS;
  - `AbortSignal` cancellation, measured as the time until the upstream sees the connection close;
  - how errors surface in LangChain, by status and error class. Construct `ChatOpenAI` with `maxRetries: 0` for the error checks, because `@langchain/core`'s `AsyncCaller` retries 429 and 500 six times by default. Add one observed check that records the default retry count and backoff for a 500, as a finding for M4 slice 1;
  - a disallowed `Origin` rejected by the proxy;
  - an expired token rejected.
- R3. **User endpoint mode.** The page calls the mock upstream directly with a user-supplied test key. The upstream's CORS allows the page origin. Record the preflight headers, streaming, abort timing and error behavior, as in R2; the proxy-only `Origin` and token-expiry checks stay in R2. Record that the key lives in page memory only. Also record the behavior when the upstream sends no CORS headers: the error class, and that the status is not visible.
- R4. **Structured output.** Through the proxy, `withStructuredOutput(zodSchema, { method: 'jsonSchema' })` sends `response_format` `json_schema`, and the page validates the reply. Record the exact request shape.
- R5. **Credential exposure checks**, recorded as booleans:
  - the upstream key never appears in any page-visible response, header or console line;
  - the browser token is never forwarded upstream;
  - LangChain error objects and messages do not contain the token. Record any field that does, as a finding.

**MCP**

- R6. **MCP test server.** It uses `@modelcontextprotocol/sdk` 1.32.1 with `StreamableHTTPServerTransport` and session IDs.
  - It exposes a read tool `lesson.lookup` and a write tool `progress.record`, with an output size control.
  - CORS and `OPTIONS` are handled in the spike's own `node:http` wrapper, without `express` or `cors` (both are transitive SDK dependencies that pnpm does not hoist; the SDK transport answers `OPTIONS` with 405). CORS allows the page origin, the methods `GET`, `POST` and `DELETE`, and the request headers `content-type`, `mcp-session-id`, `mcp-protocol-version` and `last-event-id`, and exposes `mcp-session-id`.
  - It validates `Origin` against an allowlist and answers 403 otherwise, in the wrapper or through the transport's `enableDnsRebindingProtection` with `allowedOrigins` and `allowedHosts` (including `127.0.0.1:<port>`).
  - It has an admin endpoint for the record script that can do three things: change a tool's description or schema; forget all sessions, so the next request gets 404; make the next tool call issue a server-to-client `sampling/createMessage` request, sent from the tool handler through `extra.sendRequest` (or `server.createMessage` without tools) on the tool call's SSE response stream. Do not use `elicitInput`: in SDK 1.32.1 it throws on the server before sending when the client declared no elicitation capability.
- R7. **MCP client in the page** (`Client` with `StreamableHTTPClientTransport`). Observe and record:
  1. initialize, the negotiated protocol version and the session header through CORS;
  2. `tools/list`, the namespacing prototype (`<serverId>.<toolName>`) and the pinning prototype: a SHA-256 over the RFC 8785 (JCS) canonical JSON of the name, description, input schema and output schema, compared on each listing. A first-seen tool stays disabled until explicitly approved, and its approved hash is stored; a changed definition marks the tool disabled until re-approved. Record both;
  3. result size limits at two layers: a response byte cap enforced before JSON parsing (for example, a `fetch` wrapper passed to the transport that counts streamed bytes and aborts over the cap), and a check on bytes of canonical JSON of the parsed result. Over either limit, the result is rejected without being passed on. Record whether the SDK transport accepts a custom `fetch`;
  4. 404 after the server forgets sessions: record what the SDK does, whether it re-initializes automatically or throws, and the prototype's re-initialization;
  5. server-to-client requests: the client declares no `sampling` or `elicitation` capability. Record what happens when the server sends one anyway, and the prototype's rejection;
  6. a disallowed `Origin`, recorded as two observations: what the browser client on a second page origin `:4184` (Vite preview of the same page, or a static server) sees, which is expected to be a preflight or CORS failure; and the server's 403 to a Node `fetch` that carries the forged `Origin`.

**Recording and report**

- R8. `scripts/record.ts` does the following:
  - starts the servers;
  - serves the page;
  - runs every R2 to R7 check in headless Chromium;
  - writes `results/<date>-headless-chromium-<version>.json` with one entry per check: its name, `passed` or `observed`, timings, and redacted headers;
  - exits non-zero only if a credential exposure check fails or a check cannot run.

  It stops every server.
- R9. `README.md`, the report, contains:
  - how to run it;
  - a results table;
  - the observed CORS behavior, including the headers a host proxy must allow;
  - the credential callback design to adopt in M4 slice 1;
  - the MCP findings and the minimal client profile to adopt in M4 slice 2, including whether to use the SDK client in `packages/` or a smaller client, with its dependency cost (for example, the size and the transitive dependencies the SDK pulls into a page bundle, measured with `vite build`);
  - proposed changes to ADR-0006 and ADR-0011, as text for the maintainer to approve;
  - an explicit "not tested" list: the localhost/Ollama and Chrome LNA path; real providers; real browsers beyond headless Chromium; HTTP/2; and the device matrix.

### Scope Boundaries

- **M4 slices 1 and 2:** no package code. Production clients are built there.
- No ADR edits.
- No CI job runs the spike. CI already runs Biome and the license-header check over `spikes/`, and both must pass.

### Assumptions

- Headless Chromium enforces CORS like headed Chrome for these cases.
- `@langchain/openai` 1.6.3 already sets `dangerouslyAllowBrowser: true` on its OpenAI client by default. The report records that the SDK's browser guard is bypassed implicitly; passing the flag is redundant.
- The SDK client bundles with Vite. It pulls in `ajv` (CommonJS), `pkce-challenge` and `jose`; if prebundling fails, the three-attempt stop condition applies.

---

## Planning Contract

### Implementation Constraints

- New files carry the SPDX header.
- TypeScript with `node` running `.ts` scripts directly, as Spike C does.
- Add a `tsconfig.json` that extends `../../tsconfig.base.json`, as in `spikes/c-ui-path`, and make `tsc -p spikes/d-remote-paths` pass.
- Commit no `node_modules`, `.DS_Store` or browser profile. `results/*.json` files are committed after `pnpm format`, because Biome's JSON formatter differs from `JSON.stringify(…, null, 2)`.
- No secrets: use only generated test tokens and in-process constants clearly named as fake (for example, `FAKE_UPSTREAM_KEY`).

### Units

- U1. Servers: upstream, proxy and MCP.
- U2. The page and the record script.
- U3. Record the run, then write the report.

## Verification Contract

| Gate | Check |
| --- | --- |
| Root CI | `pnpm check` passes. Biome and the license-header check include the spike files. |
| Spike types | `tsc -p spikes/d-remote-paths` passes. |
| Spike run | `pnpm --dir spikes/d-remote-paths record` exits 0 and writes the results file. |
| Protected paths | `git diff --stat main -- packages examples tests docs/adr pnpm-lock.yaml` is empty. |

## Definition of Done

U1 to U3 are complete, the results file and the report are committed, and GitHub CI is green.

## Appendix

### Sources

- Brief §16.2 (Spike D), §8.4, §9.5 and §9.7.
- ADR-0006, ADR-0011 and ADR-0012.
- `spikes/c-ui-path` for the spike layout.
- `@modelcontextprotocol/sdk` 1.32.1 and `@langchain/openai` 1.6.3 in `spikes/d-remote-paths/node_modules`.
