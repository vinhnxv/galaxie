# Remote quiz host

This second host runs the unchanged [`@galaxie/example-english-tutor`](../english-tutor) package. The graph runs in the browser. The quiz uses `@galaxie/models/openai` through a same-origin backend stub; sentence feedback stays in-browser. Lessons and progress use HTTP capabilities, and saving waits for a separate host-rendered confirmation.

From the repository root, with the installed workspace dependencies:

```sh
pnpm --filter @galaxie/example-host-remote dev --mode test
```

Open the printed `http://127.0.0.1:<port>` URL. Click Start, then Allow to send the public lesson text to the quiz service. In test mode, feedback uses `MockChatModel` with this exact scripted sentence:

```text
Galaxie remote sentinel 9a2d she walk to school
```

Answer the quiz, submit that sentence, continue through Feedback, then choose Save or Don't save. Declining quiz consent sends no model request. Declining the save sends no progress request.

Default mode requires Chrome Built-in AI already reporting `available` for English:

```sh
pnpm --filter @galaxie/example-host-remote dev
```

The app checks availability after Start. If feedback is unavailable, it shows a fixed message and does not start the lesson. It never initiates a model download or falls back to remote feedback. This example uses no WebLLM worker or bundle.

Build and preview either mode with the same mode on both commands:

```sh
pnpm --filter @galaxie/example-host-remote build --mode test
pnpm --filter @galaxie/example-host-remote preview --mode test
```

Both Vite servers bind to `127.0.0.1`; the middleware checks Host against the actual listening port and rejects any supplied foreign Origin. The CSP uses `connect-src 'self'` and `trusted-types 'none'` in every mode. Model-produced props render only as React text through the education registry.

Unlike host-local, this host uses `MemorySaver`, with no IndexedDB, Web Lock or recovery store. A reload starts over, and writing drafts are lost. A cached browser-history return reloads the page to Start with a fresh runtime. Each runtime uses the fixed principal `demo-learner`; the stub derives that learner from the bearer token, never from capability arguments. Tokens live only in page memory, expire after 300 seconds, and renew when at most 60 seconds remain. Model credentials and HTTP binding headers share that renewal helper. The header shows each role's selected destination class from its snapshot.

`progress.save@1` uses `approval: 'confirm'` and `retry: 'none'`. The confirmation projects the validated lesson ID and score from the broker's frozen arguments. It is separate from agent UI, single-use and held only in memory. Cancellation or a lost response cannot undo a write already sent; this example provides no backend reconciliation or durable deduplication. Scores are local practice, not authoritative assessment results.

The backend is a demonstration stub: one demo learner, deterministic quiz responses, in-memory records and no real provider or accounts. It does not forward requests upstream. Consequently the quiz descriptor uses `host-server`, with zero token pricing to fit the default zero cost budget. A real host must:

- authenticate and authorize every request and lesson, enforce spending limits on the proxy, and keep its provider key on the backend;
- issue short-lived tokens scoped to the learner's allowed capabilities, rather than the user's full session;
- price the proxy and raise `RuntimeOptions.budgets.cost` to the host's finite allowance;
- declare the final recipient as `third-party` if the proxy forwards to an external provider, with matching routing policy and consent;
- keep learner sentences and checkpoints on-device, and treat practice scores as untrusted client input.

These obligations follow brief §9.7 B1, B3, B10 and B11 and ADR-0006. Same-origin scripts can read the page's tokens. The host registers no trace exporter or diagnostic forwarder: raw host-only `DiagnosticEvent.error` must never be sent to a destination private data may not reach. Public errors remain fixed, without host error text or causes; request bodies and credentials are never logged.

In test mode only, authenticated `GET /api/__test/state` exposes recorded quiz bodies, progress records and route counts for assertions. It is absent in default mode. The backend deliberately copies the lesson fixture so Vite's config bundle imports no workspace build output; a Node test checks it against the tutor's fixture.

Verification:

```sh
pnpm exec vitest run --project node examples/host-remote/test
pnpm check
CI=true pnpm test
```

The loop test builds both modes and drives headless Chromium against `vite preview`. It uses the real OpenAI-compatible adapter against the deterministic stub and a mock feedback model, verifies both decline paths, CSP, desktop/mobile layout, reload-to-Start and sentence-free request bodies, and blocks requests outside the preview origin. Node tests cover token expiry and renewal past 300 seconds, Host/Origin guards, progress schema parity and JSON/SSE replies. Tests download no weights, load no real WebLLM bundle and call no real `LanguageModel` global. Real-provider verification and the second external developer trial remain outside this slice.
