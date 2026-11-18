# Remote quiz host

This second host runs the unchanged [`@galaxie-ai/example-english-tutor`](../english-tutor) package. The graph runs in the browser. The quiz uses `@galaxie-ai/models/openai` through a same-origin backend stub; sentence feedback stays in-browser. Lessons and progress use HTTP capabilities, and saving waits for a separate host-rendered confirmation.

The bundled [galaxie.config.json](galaxie.config.json) holds the HTTP capability policy, model descriptors, role routes and quiz endpoint with origin-relative URLs. [host-config.ts](src/host-config.ts) validates it against the tutor definition and maps the named `session`, `model-proxy` and `quiz-consent` hooks to host code. [runtime.ts](src/runtime.ts) validates once at startup, builds fresh options per instance and constructs the quiz model from the built endpoint. Headers, credentials, consent and the in-browser feedback model stay in code; the file contains no secrets or header values. See the [host configuration guide](../../docs/guides/host-configuration.md) for the trust rule and format; ADR-0031 stays Proposed.

From the repository root, with the installed workspace dependencies:

```sh
pnpm --filter @galaxie-ai/example-host-remote dev --mode test
```

Open the printed `http://127.0.0.1:<port>` URL. Click Start, then Allow to send the public lesson text to the quiz service. In test mode, feedback uses `MockChatModel` with this exact scripted sentence:

```text
Galaxie remote sentinel 9a2d she walk to school
```

Answer the quiz, submit that sentence, continue through Feedback, then choose Save or Don't save. Declining quiz consent sends no model request. Declining the save sends no progress request.

Default mode requires Chrome Built-in AI already reporting `available` for English:

```sh
pnpm --filter @galaxie-ai/example-host-remote dev
```

The app checks availability after Start. If feedback is unavailable, it shows a fixed message and does not start the lesson. It never initiates a model download or falls back to remote feedback. This example uses no WebLLM worker or bundle.

Build and preview either mode with the same mode on both commands:

```sh
pnpm --filter @galaxie-ai/example-host-remote build --mode test
pnpm --filter @galaxie-ai/example-host-remote preview --mode test
```

Both Vite servers bind to `127.0.0.1`; the middleware checks Host against the actual listening port and rejects any supplied foreign Origin. Session issue, model requests and end-session also reject a missing Origin; bearer-only capability routes allow it. The CSP uses `connect-src 'self'` and `trusted-types 'none'` in every mode. Model-produced props render only as React text through the education registry.

Unlike host-local, this host uses `MemorySaver`, with no IndexedDB, Web Lock or recovery store. A reload starts over, and writing drafts are lost. A cached browser-history return reloads the page to Start with a fresh runtime. Each runtime uses the fixed principal `demo-learner`; the stub derives that learner from the bearer token, never from capability arguments. Capability bearer tokens live only in page memory, expire after 300 seconds, and renew when at most 60 seconds remain. The same session issue sets a separate `galaxie-agent-session` cookie: HttpOnly, SameSite=Strict, Path `/api/v1`, Max-Age=300 and no Domain. Before each model call, `getCredential` awaits that renewal helper and returns the constant `host-remote-placeholder`; the browser carries the cookie, and the model proxy ignores the incoming Authorization value. Capability bindings retain `credentials: 'omit'` and bearer authentication and reject cookie-only authority. The header shows each role's selected destination class from its snapshot.

`progress.save@1` uses `approval: 'confirm'` and `retry: 'none'`. The confirmation projects the validated lesson ID and score from the broker's frozen arguments. It is separate from agent UI, single-use and held only in memory. Cancellation or a lost response cannot undo a write already sent; this example provides no backend reconciliation or durable deduplication. Scores are local practice, not authoritative assessment results.

The backend is a demonstration stub: one demo learner, deterministic quiz responses, in-memory records and no real provider or accounts. The proxy builds an allowlisted request for an in-process stub upstream, substituting its server-only key and forwarding only `content-type`, `accept` and its own `authorization`. The stub checks that key before replying. `HOST_REMOTE_UPSTREAM_KEY` supplies the key when set; otherwise it is random per process. Never give that variable a client-exposed prefix such as `VITE_`. Consequently the quiz descriptor uses `host-server`, with zero token pricing to fit the default zero cost budget. A real host must:

- authenticate and authorize every request and lesson, enforce spending limits on the proxy, and keep its provider key on the backend;
- issue short-lived tokens scoped to the learner's allowed capabilities, rather than the user's full session;
- price the proxy and raise `RuntimeOptions.budgets.cost` to the host's finite allowance;
- declare the final recipient as `third-party` if the proxy forwards to an external provider, with matching routing policy and consent;
- keep learner sentences and checkpoints on-device, and treat practice scores as untrusted client input.

These obligations follow brief §9.7 B1, B3, B10 and B11 and ADR-0006. Same-origin scripts can read the page's capability tokens and can call the model proxy while the cookie session lasts; the example enforces no spending limit. HttpOnly keeps the model-session value out of page code, and the upstream key never reaches the page. Add `Secure` on HTTPS and follow the [host guide](../../docs/guides/host-integration.md#remote-models-through-a-host-proxy) for cookie limits and real upstream request/response handling.

**Start over** disposes the lesson runtime and posts to `/api/v1/session/end` before enabling Start again. The endpoint revokes the session identified by the cookie, including its bearer token, and expires the HttpOnly cookie even if no live session exists. The client drops its cached bearer token even if that request fails. Call the endpoint at sign-out and on a user change in an account-based host.

Tabs on the same origin share the model cookie. Each tab caches its own bearer token in memory. After one tab ends the shared session, another tab with a cached token gets 401 from the model proxy, and from the bearer-authenticated lesson and progress calls, until that tab renews its own token (a reissue by another tab restores only model requests), which may happen when a tab next renews its token or starts a lesson. Reissuing on the same origin replaces the shared cookie with a valid one for the same demo learner, so every tab uses the replacement for model requests. A preceding session replaced by renewal through the same getter lapses within 60 seconds. Independently issued sessions can retain bearer authority until their own 300-second expiry. On issuance, the backend checks both session indexes for expired entries at most once a minute. The demo has open issuance and no limit on the issuance rate. A real host must require sign-in on issuance, refuse it after sign-out, and revoke all of the principal's sessions for cross-tab sign-out. Cookies ignore ports, so two example servers on `127.0.0.1` in the same browser profile can overwrite each other's agent cookie and cause model requests to the other server to return 401.

The host registers no trace exporter or diagnostic forwarder: raw host-only `DiagnosticEvent.error` must never be sent to a destination private data may not reach. Public errors remain fixed, without host error text or causes; request bodies and credentials are never logged.

In test mode only, bearer-authenticated `GET /api/__test/state` exposes recorded quiz bodies, forwarded header names (never values), progress records, route counts and session index sizes for assertions. It is absent in default mode. The backend deliberately copies the lesson fixture so Vite's config bundle imports no workspace build output; a Node test checks it against the tutor's fixture.

Verification:

```sh
pnpm exec vitest run --project node examples/host-remote/test
pnpm check
CI=true pnpm test
```

The loop test builds both modes and drives headless Chromium against `vite preview`. It uses the real OpenAI-compatible adapter against the deterministic stub and a mock feedback model, verifies the HttpOnly cookie and placeholder Authorization, scans browser-visible artifacts and both builds for the test upstream key, and checks both decline paths, CSP, desktop/mobile layout, reload-to-Start and sentence-free request bodies while blocking requests outside the preview origin. Node tests cover cookie attributes and expiry, cookie-only capability rejection, end-session revocation, duplicate-cookie refusal, the header allowlist and key leakage, exact/missing Origin rules, unchanged bearer renewal past 300 seconds, progress schema parity and JSON/SSE replies. The [configuration parity test](test/config-parity.node.test.ts) validates the shipped file in CI, compares its policies, requests and routing against the pre-migration hand-built wiring, and proves that a model-name-only JSON edit changes the request recorded by the proxy. Mutations check undeclared capability names and unknown header hooks against fixed error codes and JSON Pointers. Tests download no weights, load no real WebLLM bundle and call no real `LanguageModel` global. Real-provider verification and the second external developer trial remain outside this slice.
