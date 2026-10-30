---
title: URL Decode Hardening, Loopback Success Test and Exit-Record Consistency - Plan
type: fix
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# URL Decode Hardening, Loopback Success Test and Exit-Record Consistency - Plan

## Goal Capsule

- **Objective:** close three gaps that a second independent audit found after closeout 3. This is closeout 4, slice 1.
  1. **AT-32.** `decodeUrl` in `packages/core/src/interactions.ts` falls back to the raw string when `decodeURIComponent` throws. A single malformed escape, such as `&x=%ZZ`, therefore hides a percent-encoded private sentence elsewhere in the same URL. `docs/unsupported.md`, `docs/system-design.md`, `docs/security-review.md` and the AT-32 row list this as a residual risk, but the code can fix it.
  2. **AT-24.** No test shows a `localhost` user endpoint working over real HTTP. Every routed success case injects `fetch`. The real loopback tests cover only a closed port and the no-CORS failure. The CORS fixture in `tests/conformance/support/http-fixture.node.ts` has no `/chat/completions` route.
  3. **Exit record.** The AT-12 row says `automated`, but the "Open items" list still names AT-12 as partial. The consistency test in `tests/conformance/mvp-exit-record.node.test.ts` never compares that list with the rows.
- **Means:** a core fix, a fixture route, tests on Node and Chromium, a consistency check, and docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0006 and ADR-0012. Do not edit any ADR.
  3. This plan.
  4. Brief AT-24, AT-32 and §16.6.
- **Execution profile:** autonomous, in Node and headless Chromium, with mock or fixture models. Work offline: tests reach only loopback servers. The only network use is `git push` and `gh` at the end. Work on the existing branch `closeout4/hardening`, which holds one commit with this plan. Open one pull request against `main`. Run U1 to U3 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - An existing test assertion must change. A new fixture route must not change the responses of existing routes. If the new route is shared, existing request-log assertions must still hold; otherwise use a separate fixture instance.
  - A golden, the compatibility matrix or an ADR would change.
  - A dependency or `pnpm-lock.yaml` would change.
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

- R1. **Decode hardening (AT-32).**
  - When full decoding fails, decode each maximal run of valid `%XX` escapes on its own. A run that is still invalid, for example a lone UTF-8 continuation byte, stays raw.
  - Keep `+`-to-space handling.
  - Apply the same partial decode to the second decoding pass.
  - Unit tests cover:
    - a percent-encoded registered sentence next to `&malformed=%ZZ`, which is denied;
    - the same with a double-encoded sentence, which is denied;
    - a malformed escape with no private value, which passes.
  - Remove the malformed-escape caveat everywhere it is documented: `docs/unsupported.md`, the system design, `docs/security-review.md`, the AT-32 row and the corpus README if present. Keep the other AT-32 residual risks: paraphrase, structured channels and unregistered values.
- R2. **Loopback success (AT-24).**
  - Add an OpenAI-compatible `/v1/chat/completions` route on a CORS-allowing loopback server. It returns a fixed non-streaming reply and a fixed SSE stream with usage. The CORS preflight allows `Authorization` and `Content-Type` for the browser runner origin, plus whatever headers the OpenAI client sends.
  - Add conformance tests on Node and Chromium that route a role with destination `user-device` to `http://localhost:<port>/v1` through `openAICompatible`. Both `invoke` and `stream` succeed through the router. Assert:
    - the snapshot route shows `user-device`;
    - the request reached the fixture;
    - errors, events and spans carry no URL or host.
  - On Node, use `localhost` or `127.0.0.1`, whichever the fixture binds, and say which in the PR. A real LNA grant stays unmeasured.
  - Update the AT-24 row to cite the success test. It stays partial because of the real Ollama and LNA items.
- R3. **Exit-record consistency.**
  - Remove AT-12 from the "Partial acceptance evidence" open item, because its row is `automated`. Keep any real abort-latency limitation in the "Additional real-device gaps" item, where it is already listed.
  - Extend `mvp-exit-record.node.test.ts`: the AT IDs named in the "Partial acceptance evidence" bullet must equal the set of rows whose status is `partial`, and `gap` rows must be named as well if any exist.
  - Update the AGENTS.md status paragraph in one clause.

### Scope Boundaries

- No new URL policy.
- No LNA API.
- No provider behavior change.

## Implementation Units

- **U1. Decode hardening.** R1.
- **U2. Loopback success.** R2.
- **U3. Exit-record consistency.** R3.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 to U3 are complete.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- `packages/core/src/interactions.ts` (`decodeUrl`, `checkInteractionUrlPolicy`) and `packages/core/test/interaction-private.test.ts`.
- `tests/conformance/support/http-fixture.node.ts`, `http-context.ts` and `openai-provider.test.ts`.
- `docs/mvp-exit-record.md` and `tests/conformance/mvp-exit-record.node.test.ts`.
