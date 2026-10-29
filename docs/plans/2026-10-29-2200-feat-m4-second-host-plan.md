---
title: M4 Second Host App - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M4 Second Host App - Plan

## Goal Capsule

- **Objective:** run the unchanged `examples/english-tutor` package in a second host app, `examples/host-remote`. Its integration shape differs from `examples/host-local` in five ways:
  1. quiz generation runs on a remote model, reached through a same-origin host proxy with `@galaxie/models/openai`;
  2. lessons and progress come from a host backend, through `httpCapability`;
  3. progress saving waits for a host-rendered confirmation (slice 3);
  4. tokens are short-lived and issued by the backend;
  5. there is no IndexedDB persistence.

  This proves reuse without graph changes (brief §16.6). It is M4 slice 4. The second external developer trial stays a maintainer task.
- **Means:**
  - a new Vite + React example, `examples/host-remote`. Its Node backend runs as a Vite plugin middleware on the dev and preview servers. The backend is a demonstration stub: no real upstream provider, no real accounts.
  - a headless Chromium loop test through Playwright with the mock in-browser feedback model and the real OpenAI-compatible provider against the backend stub;
  - docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0002, ADR-0006, ADR-0012 and ADR-0014. Do not edit any ADR.
  3. This plan.
  4. Brief §16.6, §9.7 and §14.
  5. `docs/system-design.md`.
- **Execution profile:** autonomous and offline, in Node and headless Chromium. Work on the existing branch `m4/second-host` and open one pull request against `main`. Run U1 to U4 in order, with `pnpm check` after each.
- **Already done on this branch:** the plan commit includes `examples/host-remote/package.json` and the updated, installed root `pnpm-lock.yaml`. Do not change any dependency further. You may add `scripts`, and the `tsconfig` files that mirror `examples/host-local`.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - any file under `examples/english-tutor/`, `packages/` or `examples/host-local/` would need to change. Docs are the exception: a README or system-design line may change.
  - an existing test assertion must change;
  - a conformance golden or the compatibility matrix would change;
  - an ADR would change;
  - a dependency or the lockfile would change again;
  - the learner sentence, or the lesson rubric with the sentence, would reach the proxy, the backend or any request body leaving the page;
  - a request would leave `127.0.0.1`;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

**Backend stub (`examples/host-remote/server/backend.ts`)**

- R1. A function `backend(options?: { now?: () => number })` returns a Vite plugin. It registers the same middleware in `configureServer` and `configurePreviewServer`, and holds all state in memory per server. It is a demonstration stub, and its header comment says so.
  - Everything reachable from `vite.config.ts` loads through Vite's config bundler, which resolves workspace packages to their git-ignored `dist/`. CI runs the tests before the build, so `server/` imports only relative files, `node:` built-ins and `import type` from `vite`, and never a workspace package.
- R2. `POST /api/session` returns `{ token, expiresAt }`. The token is a random value from `crypto.randomUUID()` that expires after 300 s, for the one demo learner `demo-learner`. Every other `/api` route requires `Authorization: Bearer <token>` and answers 401 for a missing, unknown or expired token.
  - **Trusted origin.** The accepted origin comes from the server's own listening address, read from `httpServer.address()` once it listens, as `http://127.0.0.1:<port>`. It never comes from the request.
  - Before issuing a token or dispatching any route, the middleware answers 403 in two cases:
    - the `Host` header is not `127.0.0.1:<port>`. This blocks DNS rebinding.
    - the request carries an `Origin` header that differs from the trusted origin.
  - A request without `Origin` is accepted, because Chromium omits it on same-origin GET.
- R3. `POST /api/v1/chat/completions` is the host proxy. In a real deployment it forwards to a provider with the host's own key. Here it answers itself:
  - a deterministic quiz in the OpenAI chat completion format, non-streaming and streaming as the request asks, with usage;
  - for a `response_format` of type `json_schema`, the content is the quiz JSON from `server/fixtures.ts`;
  - streaming replies use `text/event-stream` with `data: <chunk>\n\n` events: content deltas, then a chunk with `finish_reason: "stop"`, then a usage-only chunk with empty `choices`, then `data: [DONE]`. The adapter streams with `stream_options.include_usage`, and the provider fails a stream that never finishes. Model the format on `packages/models/test/support/fake-openai-fetch.ts`.
  - it records each request body in memory for tests.

  It never logs request bodies.
- R4. `GET /api/lessons/:lessonId` returns `server/fixtures.ts`'s copy of the tutor's `lessonFixture` as `application/json`, or 404 for any other ID. The copy exists because of R1's import rule. `backend.node.test.ts`, which runs under the Vitest aliases, asserts that it deep-equals `lessonFixture`.
- R5. `POST /api/progress` accepts `{ lessonId, score, total }`.
  - It validates the body by hand: only those keys, a string `lessonId`, and integer `score` and `total` from 0 to 20 with `score <= total`.
  - It takes the learner from the token, never from the body, and stores the record.
  - It returns the tutor's `ProgressOutput` shape as `application/json`, and answers 403 when the lesson is unknown.
  - `backend.node.test.ts` asserts that the hand validator agrees with `ProgressInputSchema` on valid and invalid samples.
- R6. A test-only route `GET /api/__test/state` returns the recorded proxy bodies, the progress records and the request count per route. It is registered only when `mode === 'test'`.

**Host app (`examples/host-remote/src`)**

- R7. Models:
  - `quiz.generate` uses `openAICompatible({ baseURL: new URL('/api/v1', location.origin).href, model: 'host-quiz' })`. It is registered with:
    - destination `host-server`;
    - features `['streaming', 'cancellation', 'structured-output']` and languages `['en']`;
    - pricing `{ inputPerToken: 0, outputPerToken: 0 }`, because the stub charges nothing and the default cost budget is 0. A real host prices the proxy and raises `RuntimeOptions.budgets.cost`.
    - `credential: true`, with a `getCredential` that returns a current session token (R7a).

    The route uses that provider, with `allow: ['host-server']` and `maxTokens: 2000`.
  - **Consent.** The router denies any non-`in-browser` destination unless `routing.consent` approves it (ADR-0006). The app's `consent` hook shows a host-rendered prompt with the fixed text "Send the lesson text to this site's quiz service?" and the buttons Allow and Don't allow, then resolves with the learner's choice. Declining fails the quiz with `denied`, and the app shows the fixed text "The quiz needs the quiz service." with a Start over button.
  - R7a. **Token renewal.** One `session.ts` helper returns the current token. It fetches a new one from `/api/session` when none exists, or when the current one expires within 60 s. Both `getCredential` and the bindings' `headers` hook call it, so a learner who takes longer than 300 s still saves.
  - `tutor.feedback` stays `local-only`, as the tutor declares, with `allow: ['in-browser']` and `maxTokens: 1000`, as in host-local. In `test` mode it uses the deterministic `MockChatModel` from `@galaxie/models/mock` with destination `in-browser`. In default mode it uses `@galaxie/models/builtin-ai`, after `checkBuiltInAI` reports `available`. Otherwise the app shows a fixed message that this host needs Chrome Built-in AI for feedback, and does not start.
- R8. Bindings use `httpCapability` with destination `host-server`. The URL templates are absolute, built by string concatenation:
  - `lessons.get@1`: `GET`, `${location.origin}/api/lessons/{lessonId}`;
  - `progress.save@1`: `POST`, `${location.origin}/api/progress`, with `approval: 'confirm'` and `retry: 'none'`.

  `httpCapability` requires a `scheme://authority` prefix. Never pass a template through `new URL()`, which percent-encodes the `{lessonId}` placeholder.

  Both send the bearer token through the binding's `headers` hook and use `credentials: 'omit'`.
- R9. Confirmations: the app passes `confirmations: { capabilities, policyRevision: () => 'host-remote-1' }` and renders a `ConfirmationPrompt` from `defineConfirmations`. The entry for `progress.save@1` has:
  - title "Save your score?";
  - the fields "Lesson" and "Score", the score as `${score} / ${total}`;
  - the labels "Save" and "Don't save".

  Declining fails the save with `denied`. The run then fails, and the app shows a fixed "Progress was not saved." text with a Start over button.
- R10. Storage and identity: `MemorySaver` from `@langchain/langgraph`, with no IndexedDB, Web Lock or recovery store. The `principalScope` is the backend's demo learner ID. The app states in its README that a reload starts over.
- R11. UI: a React app using `AgentSurface` with the `education/v1` registry and `educationComponents` from `@galaxie/react`, plus a header that shows the current destination class per role from `snapshot.routes`. It reuses the CSP approach of host-local: `connect-src 'self'` and `trusted-types 'none'` in every mode, because there is no worker and no remote host. `main.tsx` first imports `src/zod-config.ts`, copied from host-local (`config({ jitless: true })`), before any module that uses Zod. Otherwise Zod's `new Function` probe violates the CSP.

**Tests**

- R12. `examples/host-remote/test/loop.node.test.ts` builds the app in `test` mode, serves it with `vite preview` and the backend plugin on `127.0.0.1`, and drives headless Chromium through Playwright, following `examples/host-local/test/loop.node.test.ts`. It covers:
  1. the full loop: start, Allow on the consent prompt, the quiz from the proxy, answers, the sentence, feedback, the confirmation with its exact host text, Save, then Progress. The backend then holds exactly one progress record for `demo-learner`, with the graded score.
  2. Don't save: no progress record, and the fixed text. Don't allow on the consent prompt: no request to `/api/v1/chat/completions`, and the fixed text.
  3. Privacy: no recorded proxy body and no request body to `/api` contains the sentinel learner sentence. Every request the page made targets the preview origin.
  4. Tokens: run from Node against the preview server.
     - A request without a token gets 401, and so do unknown and expired tokens. Expiry is checked in `backend.node.test.ts` with an injected `now`.
     - A request with a foreign `Origin` gets 403, and so does a foreign `Host` with a matching `Origin`. Use `node:http` for the `Host` case, because `fetch` cannot set `Host`.
     - A save after token renewal succeeds, with `now` advanced past 300 s.
  5. CSP: the preview response carries the CSP header, and the page reports no CSP violation.
- R13. `git diff --stat main -- examples/english-tutor packages examples/host-local` is empty, docs excepted.

**Docs**

- R14. `examples/host-remote/README.md` covers:
  - how to run it, in `test` mode and in default mode with Chrome Built-in AI;
  - the integration shape, and how it differs from host-local;
  - that the backend is a stub. Real hosts forward to a provider with their own key, authorize every request, enforce spending limits on the proxy, and issue short-lived scoped tokens (brief §9.7 B1, B3, B10 and B11).
  - its limits: no persistence, one demo learner, no real provider.

  Also update the AGENTS.md project status paragraph, the README status and system design §16.6 or the nearest status section. Never describe the example as secure.

### Scope Boundaries

- No change to the tutor package, the packages or host-local.
- No MCP in this host. MCP has its own example and conformance tests.
- No real provider, no real accounts, no deployment config.
- The second external developer trial is a maintainer task, out of scope.

### Assumptions

- The OpenAI-compatible provider accepts `http://127.0.0.1:<port>` as a loopback `baseURL`, which its validation allows.
- `vite preview` honors `configurePreviewServer` middleware in Vite 8.3.4.
- The tutor's lesson content is labeled `public`, so it may reach `host-server`. The learner sentence is `private-user`, so only the `local-only` feedback role sees it.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Integration shape, not a new UI stack.** The tutor's catalog components and their schemas live in `@galaxie/react`. A non-React host would have to duplicate those catalog contracts or change the package, and either risks R13. A second React host with a remote integration shape exercises the parts M4 adds: the remote provider, HTTP capabilities and confirmations.
- KTD2. **The backend lives in a Vite plugin.** One process serves the page and the backend from the same origin, so `connect-src 'self'` holds. The test needs no second server or port.
- KTD3. **Confirm the save.** `progress.save@1` is the tutor's only write. Binding it with `approval: 'confirm'` is a host decision that needs no graph change, and it demonstrates A5 in an app.

### Output Structure

```text
examples/host-remote/
  README.md
  index.html
  package.json            (committed with the plan)
  tsconfig.json
  vite.config.ts          (aliases as in host-local; backend plugin; CSP headers)
  server/backend.ts
  server/fixtures.ts
  src/main.tsx
  src/app.tsx
  src/runtime.ts
  src/csp.ts
  src/zod-config.ts
  src/session.ts
  test/tsconfig.json
  test/loop.node.test.ts
```

- Add the new projects to the root `typecheck`, `typecheck:ts6` and `build` scripts.
- Add the test to the Vitest Node project the same way host-local's loop test is included.
- Add `check:deps` rules for the new example:
  - `src/` may import `@galaxie/*`, `@galaxie/example-english-tutor`, `react`, `react-dom`, `@langchain/*` and `zod`, and must not import `server/`.
  - `server/` may import only relative files, `node:` built-ins and `import type` from `vite`.
  - `test/` may additionally import `vite`, `playwright` and `vitest`.

### Implementation Constraints

- New files carry the SPDX header. The compiler rules in AGENTS.md apply.
- Render model-produced text only as React text. Never use `dangerouslySetInnerHTML`.
- The backend never echoes request bodies or tokens in a response or a log.
- Every server binds to `127.0.0.1`.

## Implementation Units

- **U1. Backend stub.** R1–R6, with Node unit tests in `examples/host-remote/test/backend.node.test.ts` against a bare Vite preview, or the middleware with `node:http`.
- **U2. Host app.** R7–R11, and a default-mode build that type-checks and builds.
- **U3. Loop test.** R12.
- **U4. Docs and boundaries.** R13, R14 and the `check:deps` rules.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Tutor and packages unchanged | `git diff --stat main -- examples/english-tutor packages examples/host-local` lists no source file. | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr` is empty. | before the PR |
| Dependencies | `pnpm install --frozen-lockfile --offline` passes. The lockfile is unchanged after the plan commit. | before the PR |

## Definition of Done

- U1 to U4 are complete.
- The unchanged tutor runs end to end in `examples/host-remote` in headless Chromium, with a remote quiz role, HTTP bindings and a confirmed save.
- The learner sentence never leaves the page.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- Brief §16.6, §9.7 (A5, B1, B3, B10 and B11) and §14.
- `examples/host-local` (`src/runtime.ts`, `src/mock-script.ts`, `src/csp.ts`, `vite.config.ts` and `test/loop.node.test.ts`).
- `examples/english-tutor/src` (the definition, the schemas and `lessonFixture`).
- `packages/models/src/openai/chat-model.ts` (`openAICompatible` and its URL validation), `packages/core/src/http-capability.ts` and `packages/react/src/confirmations.tsx`.
