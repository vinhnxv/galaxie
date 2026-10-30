---
title: Typed Unreachable Error for User Endpoints - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Typed Unreachable Error for User Endpoints - Plan

## Goal Capsule

- **Objective:** implement the AT-24 contract that brief §10.4 and the ADR-0006 consequences already decide:
  - a `localhost` or LAN user endpoint whose request fails at the network level reports the typed `unreachable` error;
  - its fixed message lists the likely causes: a Local Network Access denial, CORS not configured for the app origin (for example `OLLAMA_ORIGINS`), or a stopped server;
  - nothing falls back.

  `unreachable` is declared in `packages/core/src/errors.ts`, but nothing produces it. Today:
  - the OpenAI-compatible provider maps a connection error to `unavailable`/`network` (`packages/models/src/openai/classify.ts`);
  - `httpCapability` maps every fetch failure to `unavailable` (`packages/core/src/http-capability.ts`).

  This is closeout 3, slice 1. The slice also fixes the AT-33 inconsistency in the exit record's open items.
- **Means:** classification changes in models and core, tests on Node and Chromium, and docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0006 and ADR-0012. Do not edit any ADR.
  3. This plan.
  4. Brief §10.4 and AT-24.
  5. `docs/system-design.md` §8.4.
- **Execution profile:** autonomous, in Node and headless Chromium. Work offline: tests reach only loopback servers. The only network use is `git push` and `gh` at the end. Work on the existing branch `closeout3/unreachable`, which holds one commit with this plan. Open one pull request against `main`. Run U1 to U3 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - An existing test assertion must change, other than an assertion that pins `unavailable` or `network` for a network failure of a `user-device` or `user-endpoint` destination. List each such change in the PR body. Assertions for `host-server`, `third-party` and `in-browser` destinations stay unchanged, including the host-server loopback CORS test in `tests/conformance/http-integration.test.ts`.
  - A golden, the compatibility matrix or an ADR would change.
  - A dependency or `pnpm-lock.yaml` would change.
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

- R1. **Rule.** A call fails `unreachable` exactly when all of these hold:
  - the destination class is `user-device` or `user-endpoint`;
  - the request failed before any HTTP response arrived: a `fetch` rejection or a connection error, not an abort and not a timeout the caller set;
  - the target URL's host is loopback, a private or LAN address (RFC 1918, link-local, `.local`), or the destination is `user-device`.

  Every HTTP status keeps today's mapping. A user abort stays `cancelled`. Every other destination keeps `unavailable`. Reuse the existing loopback helper in `packages/core/src/urls.ts` and add a private-address check beside it, with tests.
- R2. **Message.** Replace the fixed `unreachable` message in `errors.ts` with one fixed English sentence that names the three causes, for example: `The endpoint did not answer. Local Network Access may be denied, the endpoint may not allow this origin through CORS, or the server may be stopped.` The message carries no URL, host or user content.
- R3. **Models.**
  - Add `unreachable` to `ModelErrorCode`.
  - The OpenAI-compatible provider applies R1 when its configured base URL is loopback or LAN. The provider knows its base URL. If it also knows its destination, use that too, without adding a required option.
  - Route the result through the existing router mapping, so that core's `GalaxieError` code becomes `unreachable`.
  - The router never tries another provider after a dispatched call fails. Verify that this already holds, and assert it.
- R4. **Core `httpCapability`.** Apply R1 using the binding's declared destination and URL. A `user-device` binding on loopback that fails at the network level fails `unreachable`. A `host-server` loopback binding keeps `unavailable`.
- R5. **Tests.**
  - Node unit tests for the classifier and the private-address helper.
  - Conformance on Node and Chromium:
    - The OpenAI-compatible provider with destination `user-device`, pointed at a closed loopback port, fails `unreachable` with the fixed message. No second provider in the role is called; assert this with a spy provider listed after it.
    - In Chromium, the same against the existing no-CORS loopback fixture fails `unreachable`.
    - `httpCapability` with `user-device` against a closed loopback port fails `unreachable`.
    - Errors, events and spans carry no URL or host.
  - Change only the assertions that the stop conditions allow.
- R6. **Docs.** Update:
  - system design §8.4 and the user-endpoint section;
  - the models README and `AGENTS.md`;
  - the AT-24 row in `docs/mvp-exit-record.md`, citing the tests. A real Ollama run and the real LNA grant and denial remain unmeasured and need a human.
  - the AT-33 inconsistency: its row is `automated`, but the "Open items" list still names AT-33 as partial. Remove it from that list, or keep it only for a stated remaining item;
  - the AGENTS.md status paragraph.

### Scope Boundaries

- No LNA permission API.
- No retry and no fallback.
- No new destination class.

## Implementation Units

- **U1. Helper, rule and message.** R1 and R2, with unit tests.
- **U2. Provider and capability wiring, and conformance.** R3–R5.
- **U3. Docs.** R6.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 to U3 are complete.
- User-endpoint network failures report `unreachable` with the likely causes, and nothing falls back.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- Brief §10.4 and the ADR-0006 consequences.
- `packages/core/src/errors.ts`, `urls.ts`, `http-capability.ts` and `model-router.ts`.
- `packages/models/src/errors.ts`, `openai/classify.ts` and `openai/*`.
- `tests/conformance/openai-provider.test.ts`, `http-integration.test.ts` and `docs/mvp-exit-record.md`.
