---
title: Shared Loaded Model Lifetime Evidence - Plan
type: test
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Shared Loaded Model Lifetime Evidence - Plan

## Goal Capsule

- **Objective:** close the AT-12 gap: "a model with other consumers stays loaded".
  - Cancellation and late-result handling already have tests.
  - Nothing shows that disposing one consumer, such as an agent instance, a run or one `RoutedChatModel`, leaves a loaded local model running for the other consumers.
  - The WebLLM engine handle unloads only in its own `dispose()` (`packages/models/src/webllm/engine.ts`). Show through the real runtime that nothing else calls it.
- **Means:** tests with the existing fake WebLLM engine and the fake Prompt API, on Node and Chromium, plus docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0006. Do not edit any ADR.
  3. This plan.
  4. Brief AT-12 and §12.3.
  5. `docs/system-design.md` §8.4.
- **Execution profile:** autonomous, in Node and headless Chromium. Work offline, except for `git push` and `gh` at the end. Use no real model. Work on the existing branch `closeout2/shared-model-lifetime`, which holds one commit with this plan. Open one pull request against `main`. Run U1 and U2 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - a non-test file under `packages/` or `examples/` would change. If a consumer's disposal does unload or break a shared model, record that with `test.fails` and a comment naming the gap, and stop.
  - an existing test assertion must change;
  - a golden, the compatibility matrix or an ADR would change;
  - a dependency or `pnpm-lock.yaml` would change;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

- R1. **Shared WebLLM handle.** Create one WebLLM provider handle backed by the fake engine from `packages/models/test/support/fake-webllm.ts`, or the conformance equivalent in `tests/conformance/webllm-provider.test.ts`. Register it as the provider for a role in one runtime that hosts two agent instances, A and B, each with a mock graph that calls the routed role. Then:
  - Start runs on A and B, and complete one call on each.
  - **Cancel A's in-flight call.** B's concurrent or queued call still completes. The engine's `unload` count stays at 0, and B is unaffected by A's reset per request beyond the documented FIFO queue.
  - **Dispose A.** `unload` is still 0, and a new run on B completes.
  - **Dispose B.** `unload` is still 0. The host owns the handle.
  - **Dispose the runtime.** Record the observed `unload` count and assert it, because it is whatever the code does today. Then the host calls the handle's own `dispose()`, which unloads exactly once. A second `dispose()` stays idempotent, which the existing tests may already cover.
- R2. **Two runtimes sharing one handle**, if the API allows it, reusing R1's fixtures. Disposing runtime 1 does not stop runtime 2's next call.
- R3. **Built-in AI.** With the fake `LanguageModel`, disposing one instance does not destroy the sessions of another instance's in-flight call. Sessions are per call, so each call's session is destroyed only when that call ends. Assert the destroy counts.
- R4. **Docs.**
  - Update the AT-12 row in `docs/mvp-exit-record.md`, citing the new tests. Set the status honestly: model lifetime evidence is mock or fake only, and real prefill abort latency stays unmeasured.
  - State the ownership rule in system design §8.4, or the WebLLM section, and in the `packages/models` `AGENTS.md` and README: the host owns provider handles, instance and runtime disposal never unload them, and the host disposes the handle when the last consumer is gone.
  - Update the AGENTS.md status paragraph in one clause.

### Scope Boundaries

- No reference counting or automatic unload.
- No product change.

## Implementation Units

- **U1. Tests.** R1–R3, in `tests/conformance/shared-model-lifetime.test.ts`.
- **U2. Docs.** R4.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| No product change | `git diff --stat main -- packages examples` lists only Markdown files. | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 and U2 are complete.
- AT-12's "other consumers" clause has tests through the real runtime.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- `packages/models/src/webllm/engine.ts` (`dispose`, `unload`, the FIFO queue) and `packages/models/src/builtin-ai/*`.
- `packages/models/test/support/fake-webllm.ts`.
- `tests/conformance/webllm-provider.test.ts` and `builtin-ai-provider.test.ts`.
- `packages/core/src/runtime.ts` (`dispose`).
- `docs/mvp-exit-record.md` row AT-12.
