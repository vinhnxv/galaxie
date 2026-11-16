# Hybrid gateway starter

A copyable Vite + React page and plain `node:http` gateway. The browser runs the same one-question agent as the [local-only starter](https://github.com/vinhnxv/galaxie/blob/main/templates/kinds/browser-only/files/README.md); its `comment` role has exactly one provider, `gateway`, with destination `host-server`. Private system prompts and backend documents stay on the gateway. The upstream model receives the rendered system prompt and the practice request. The browser holds a short-lived demo bearer in memory, never the upstream provider key.

## Requirements and running

Use Node.js 24 and npm 12 or later. From this project's directory, use the seven-day release-age policy:

```sh
npm install --min-release-age=7 --registry=https://registry.npmjs.org/
npm run dev
```

Open Vite's `http://127.0.0.1` URL. The gateway checks the exact loopback Host and, when present, Origin. The Vite plugin mounts the same gateway for dev and preview. When both `UPSTREAM_BASE_URL` and `UPSTREAM_API_KEY` are unset or empty, dev and preview answer through an in-process mock upstream. The reply names the mock, and the page shows `Replies are fixed sample text from a mock upstream.` only after a successful mock response. The mock proves wiring, not provider behavior: it performs no network I/O, opens no port and receives no upstream credential. If exactly one variable is non-empty, the gateway keeps returning `503 unavailable`; partial configuration is never mocked.

To use a real upstream in dev, preview or the standalone server, set both environment variables in the launching process:

- `UPSTREAM_BASE_URL`: the trusted OpenAI-compatible API base, including `/v1`; the gateway appends `/chat/completions`.
- `UPSTREAM_API_KEY`: the upstream credential, read at runtime only by server code. Supply it through your environment's secret mechanism; never write it into source, `.env`, a command committed to the repository, or any `VITE_*` variable.

To serve a built page and gateway with Node:

```sh
npm run build
npm run build:server
node .server/server/serve.js
```

Open `http://127.0.0.1:4173`. This command compiles only the gateway, static server and CSP module into `.server/`. The production entry never imports `server/dev.ts` or `server/mock-upstream.ts`, and neither file is compiled. With no upstream configured it returns `503 {"error":"unavailable"}`. Use this compiled entry for a production-shaped deployment; `vite preview` remains a development convenience and can select the mock. The template declares its own pinned TypeScript, Node and React type tooling, so a copied project can type-check its sources and compile the server without repository-root tools. The static server serves only `dist/`, sends the CSP response header and never falls through from an API route to a file.

The four launch dependencies use exactly `^0.1.0` and resolve from the public npm registry. In repository validation, workspace settings link those ranges locally. Standalone npm installs, production builds, source checks and compiled-server Chromium unavailable flows pass on Node 22.23.5 and 24.15.0 without an upstream; see the [verification record](https://github.com/vinhnxv/galaxie/blob/main/docs/standalone-verification.md) for the initial preview request-abort failure, its loopback-tested correction, and controls and limits. The dev/preview mock flow passes repository browser tests; the network matrix was not rerun after that correction. The declared Node floor is 22.22.2; only those two patch versions were tested. To run the generated checks and compiled server:

```sh
npm run check
npm run build
npm run build:server
node .server/server/serve.js
```

Real upstream behavior and other package managers remain unmeasured. Repository validation adds `tsconfig.workspace.json` to map package sources for checks, without affecting the standalone Vite build; those mappings and repository-only tests are not shipped in a generated project. No executable source imports another template, example or package by relative path. A generated agent may diverge from the shared starter.

`npm run check` type-checks the application, Vite config and generated check, compiles the Node server, then compares Vite's development and preview CSP headers in production and mock modes and the compiled static handler's HTTP header with the pinned baseline, including Trusted Types. It also scans the production entry's transitive imports, checks that compiled output contains no dev/mock files or imports, and proves an authenticated completion returns 503 without an upstream even while the mock source exists. It does not run the repository's browser or gateway behavior suites.

## Routing, prompts and credentials

Choose **Start with gateway** to allow this practice request to use the gateway. The host then overrides the agent's requested local-only policy with the single host-server route. It uses a `MemorySaver`; reload starts over. The agent itself is byte-identical to local-only, including its ID and question. See [local-only persistence](https://github.com/vinhnxv/galaxie/blob/main/templates/kinds/browser-only/files/README.md#persistence-and-principal-identity) and the [layered host guide](https://github.com/vinhnxv/galaxie/blob/main/docs/guides/host-integration.md#layer-1-persist-recover-own) before adding IndexedDB, recovery and ownership.

`createHybridHost({ fetch, baseURL })` allows test injection and defaults to the page's origin. Its session helper requests `{ userId: 'demo-ada' }`, shares an in-flight refresh and renews when 60 seconds remain. **Replace this placeholder and the demo session endpoint with your application's trusted sign-in integration before adding real users.** Only the server-held token record determines the principal. Browser-supplied identity in model bodies, note arguments, queries or headers cannot select another user's records.

The token reaches `openAICompatible` through the router's per-call `getCredential`; the provider puts it in `Authorization: Bearer ...`. The provider's supported fetch injection adds a host-owned JSON carrier:

```json
{ "metadata": { "promptId": "practice-comment", "variables": { "tone": "encouraging" } } }
```

The provider has no arbitrary-body option. The fetch wrapper adds this metadata and removes agent-authored `system` and `developer` messages before forwarding, without changing the agent or packages. That text never reaches the upstream; the gateway owns the system prompt through `promptId`. The gateway validates the ID and exact variable schema (non-empty strings, `tone` at most 32 characters), renders its private template, strips metadata and identity fields, and prepends its own system message. Direct browser requests containing `system` or `developer` messages are still refused by the gateway. Unknown top-level model fields are not forwarded. Only user/assistant text, the allowlisted model, stream selection and a fixed 48-token output cap reach the upstream. Successful JSON or SSE bytes, including usage, pass through unchanged; upstream error bodies and headers do not pass through. Only a successful response dispatched through the injected mock receives the fixed `x-galaxie-upstream: mock` header.

The supplied `host-server` classification assumes host-operated upstream inference. If the upstream belongs to a third party, the final recipient changes: review the route's destination, data-label policy and consent before sending application data. A proxy does not make third-party inference host-local.

Credentials are absent from run events, snapshots, DOM, Web Storage, URLs, built files and committed configuration. The session issuance response necessarily contains its token; subsequent responses do not intentionally include it. Neither the page nor server logs credentials. Same-origin scripts and dependencies can read the in-memory bearer, and a trusted upstream can return sensitive text in a successful response: pass-through is not output redaction. Keep upstream credentials out of response content and errors. No tracing exporter is configured.

## Routes and fixed errors

Every gateway response sends `cache-control: no-store`. JSON request bodies are capped at 16,384 bytes. Missing, malformed or oversized bodies return fixed `400 invalid`. Errors contain only codes, without stacks, request content, upstream bodies or credentials.

| Route | Behavior and errors |
| --- | --- |
| `POST /api/session` | Known demo `userId` returns a random scoped token and `expiresAt`, valid for five minutes. Unknown users return `401 unauthorized`. At most 1,000 unexpired sessions; capacity returns `503 unavailable`. |
| Other `/api/*` routes | Missing, unknown, expired or wrongly scoped tokens return `401 unauthorized`. Foreign Host/Origin returns `403 forbidden`. Authenticated unknown routes return `404 not_found`. |
| `POST /api/v1/chat/completions` | JSON or SSE. Default allowlist: `gateway-comment`. Unlisted model: `403 model_not_allowed`; browser system/developer or malformed messages: `400 invalid_messages`; unknown prompt: `400 invalid_prompt`; invalid variables: `400 invalid_variables`. At most 32 text messages. |
| Model quota | Default 10 calls per authenticated user per 60-second window, shared across sessions and reserved before dispatch. Over quota: `429 quota_exceeded` with no upstream request. Other users are unaffected. Failed upstream attempts consume quota. |
| Upstream failures | Missing production configuration or partial dev/preview configuration: `503 unavailable`; upstream 401/403: `403 denied`; upstream 429: `429 quota_exceeded`; other failures: `502 unavailable`. Redirects refuse; requests abort after 30 seconds or browser disconnect. A stream failing after headers ends; the client handles the incomplete stream. |
| `POST /api/notes` | `note.save@1`: non-empty `text`, at most 2,000 characters. Missing/invalid key: `400 idempotency_key_required`; conflicting digest: `409 idempotency_conflict`; capacity: `503 unavailable`. |
| `GET /api/docs/search?q=...` | `docs.search@1`: non-empty query, at most 200 characters; invalid query: `400 invalid`. Searches only the user's readable subset. At most five results, 120-character titles and 160-character snippets. |

`src/gateway-state.ts` owns the status text: ready and mock have no control; mock shows the fixed sample-text message only after a successful labeled response. 401/403 show the fixed denied message, 429 the quota message, and other failures unavailable, each with one Retry. Retry clears the cached demo session and starts a new question; wait for the quota window before retrying quota failures. Raw error text never becomes a status. The direct model client's existing error contract is `unavailable` with reason `not_allowed` for 401/403 and `rate_limited` for 429; the template maps HTTP status to its own fixed UI state without changing those package contracts.

## Capability bindings and idempotency

The starter agent has no capabilities; these routes and bindings are examples for a host adding narrow capabilities to its own definition. This copy-pasteable wiring uses the same fields and retry policy as the gateway tests. The host provides its renewable `token()` function and trusted origin, binds these under `bindings`, declares matching input/output schemas, and configures a host-rendered confirmation for writes. Directly invoking a binding in tests does not exercise the broker's confirmation gate.

```ts
import { httpCapability } from '@galaxie-ai/core';

function gatewayBindings(origin: string, token: () => Promise<string>) {
  const policy = {
    destination: 'host-server',
    timeoutMs: 10_000,
    concurrency: 1,
    grantScope: 'run',
    credentials: 'omit',
    headers: async () => ({ authorization: `Bearer ${await token()}` }),
  } as const;
  return {
    'note.save@1': httpCapability<{ text: string }, { id: string; saved: boolean }>({
      ...policy,
      url: `${origin}/api/notes`,
      method: 'POST',
      kind: 'write',
      approval: 'confirm',
      retry: 'idempotency-key',
    }),
    'docs.search@1': httpCapability<
      { q: string },
      { results: { id: string; title: string; snippet: string }[] }
    >({
      ...policy,
      url: `${origin}/api/docs/search?q={q}`,
      method: 'GET',
      kind: 'read',
      approval: 'none',
      retry: 'idempotent',
    }),
  };
}
```

Core sets `Idempotency-Key` to `CapabilityContext.effectId` after the host's header callback. The gateway keys receipts by authenticated principal, key and capability name, with a SHA-256 digest of the accepted `{ text }`. Identity fields are ignored. Same key and digest returns the stored response and applies the write once; another digest returns 409. Another user's identical key is a separate record and response. The gateway stores at most 1,000 receipts, for five minutes by default; it refuses new writes at capacity rather than evicting live receipts. Expired receipts are removed on the next request. Replays after TTL or a process restart can apply a write again. Notes are capped at 1,000 per gateway process. No general exactly-once or durable-write guarantee is provided.

## Limits and verification

`createGateway` accepts upstream settings, an optional in-process `mockUpstream` handler supplied only by the Vite dev/preview entry, user/scopes table, quotas, model allowlist, prompt/variable tables, document set, receipt retention and an injected clock. Defaults are obviously fake users `demo-ada` and `demo-lin`, with different fake readable documents. The unauthenticated demo session endpoint accepts either ID: **these are not production authentication or authorization for real accounts**. All state is in memory and process-local. Deployments need their own authenticated sessions, durable transactional receipts, storage, retention, request-rate limits and cross-process quota enforcement. Call-count quotas and token caps do not establish a money-denominated spending limit; configure provider billing limits. This gateway is a starting point.

The CSP permits connections only to `'self'`, requires Trusted Types and allows no Trusted Types policies, with same-origin scripts and deny-by-default directives copied from the local starter's approach. Serve the same header when deploying elsewhere. The bundled demo server binds only `127.0.0.1`; adapting it to a public origin, TLS termination and production authentication requires host review. No login, logout, persistence, real-provider fallback, metrics or output filter is included.

The [repository-only tests](https://github.com/vinhnxv/galaxie/tree/main/templates/kinds/gateway/workspace/test) are not shipped in this project. Run the generated baseline locally with:

```sh
npm run check
```

- `gateway.node.test.ts`: dev selection, credential-free JSON/SSE mock responses, concurrent mock quotas, system/developer role projection, real OpenAI-compatible client JSON/stream integration, production 503, loopback stub upstream, token expiry/scopes, quota isolation, allowlist and prompt validation, JSON/SSE usage, galaxie HTTP idempotency and document scoping, limits, session renewal, same-agent completion, and event/snapshot/response credential canaries.
- `contracts.node.test.ts`: dependency pins, import boundaries, fixed state table and CSP. Repository composer tests check that both kinds start with identical agent bytes.
- `browser.node.test.ts`: Vite build, actual Node static server and gateway, Playwright question/result, same-origin traffic, console/page errors (the one caught eval probe described below is the only message allowed), DOM and Web Storage, built-file and template-source canary scans, plus HTTP mock completions through Vite dev and preview.
- `app.test.ts`: Chromium component coverage of fixed status rows including the mock message without a button, actual 401/429/unavailable model failures, one Retry and fresh-question behavior without raw text.

Under the page's Trusted Types CSP, zod's one-time eval-support probe (`new Function('')`) is blocked, logs `This document requires 'TrustedScript' assignment.` once in the console and falls back to schema checks without code generation. This is expected; do not loosen the CSP to silence it. The browser test allows exactly that message and fails on any other console error.

Tests use the in-process mock or a loopback stub upstream; no real credential or real model is required. In-memory spans are **not exercised**; event and snapshot scans do not establish a span-export result. The Node and Chromium suites run over loopback against that stub, so they establish gateway and page behavior only, not behavior against a real provider. Real upstream compatibility, provider billing, production authentication/storage, real-device behavior, latency and memory use remain unverified and unmeasured.


## ADK Go agent

Choose `--framework adk-go` for the same gateway flow with the prebuilt Go agent
in a dedicated Worker. See `GO.md` for editing, cache precedence and the Go
1.27.3 requirement. The private adapter and starter artifacts require local
npm tarballs until a separate release publishes them. `dev` builds once and then
runs Vite preview; rerun it after Go edits. The Go header matches the existing
ADK Go recipe's mock header: same-origin scripts and Workers, `wasm-unsafe-eval`,
required Trusted Types and an allowlisted `default` Worker URL policy. Existing
JavaScript headers and server authorization checks are unchanged. Preview uses
the fixed mock upstream; the production server still returns 503 without an
upstream. Real models and browsers beyond Chromium are unmeasured for this overlay.
