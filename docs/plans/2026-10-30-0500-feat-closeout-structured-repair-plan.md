---
title: MVP Closeout - Bounded Structured-Output Repair - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# MVP Closeout - Bounded Structured-Output Repair - Plan

## Goal Capsule

- **Objective:** close the AT-20 gap that the MVP exit record lists: "repairs are bounded". Brief §8.6 requires galaxie to validate structured output, allow a bounded number of repairs and then return an understandable error. The `repairAttempts` budget (default 2) exists in `packages/core/src/policy.ts` and is validated, but nothing enforces it, and routed `withStructuredOutput` never repairs.

  This slice adds host-enabled, budget-bounded repair to routed structured output. It is closeout slice 1 of 4.
- **Means:**
  - a per-role opt-in in core;
  - a run-level repair counter enforced by core;
  - a repair loop in the LangGraph adapter's routed `withStructuredOutput`;
  - tests on Node and Chromium;
  - docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0002, ADR-0006, ADR-0012 and ADR-0016. Do not edit any ADR.
  3. This plan.
  4. Brief §8.6, §9.4 and AT-20.
  5. `docs/system-design.md` §8.4.
- **Execution profile:** autonomous, in Node and headless Chromium.
  - Work offline except for `git push` and `gh` at the end.
  - Work on the existing branch `closeout/structured-repair`, which holds one commit with this plan.
  - Open one pull request against `main`.
  - Run U1 to U4 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - an existing test assertion must change. With repair off by default, current behavior must be unchanged.
  - a golden, the compatibility matrix or an ADR would change;
  - a dependency or `pnpm-lock.yaml` would change;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

**Core**

- R1. `ModelRoute.repairAttempts?: number` is a per-call maximum number of repair calls for routed structured output on that role.
  - The default is `0`, which means no repair, so current behavior is unchanged.
  - It must be a non-negative safe integer, or creation fails `invalid` with the existing fixed message style.
- R2. The run budget enforces `BudgetLimits.repairAttempts`, a run-wide total that is already validated and defaults to 2.
  - The claim travels as `ModelPort.begin(role, { signal, requires, repairAttempt: n })`, where `n` is the 1-based attempt index that the adapter's structured wrapper tracks for each invocation.
  - The adapter passes `n` through call options, the same way it passes `jsonSchema`.
  - Core checks it right after `assertActive` and the role lookup, before any availability probe, consent, selection or reservation.
    - If `n` exceeds the route's `repairAttempts` (default 0), core throws the fixed `invalid` error.
    - Otherwise core claims the run-wide budget through a new `RunBudget.reserveRepair()`. On exhaustion it calls `run.failBudget('repairAttempts')` and throws `BudgetExceeded`, matching the other budgets. Then `begin` continues as an ordinary call.
  - Add a core test that a refused claim with repair off triggers no availability, consent or route-change side effect.
  - When only the per-call limit is reached, no repair happens and the call fails with the existing fixed `invalid` error.
- R3. A repair call is an ordinary routed model call. It reserves and settles tokens and cost, and follows the same labels, consent, output safety and destination rules. It charges no `steps` or `toolCalls`: model calls charge neither, because steps are LangGraph supersteps and toolCalls are capability calls. In addition, it consumes the run-wide `repairAttempts` budget. Repair never bypasses or weakens a check.

**Adapter (`packages/adapter-langgraph/src/routed-chat-model.ts`)**

- R4. Routed `withStructuredOutput` returns one wrapper Runnable over `(input, config)`, replacing `assembleStructuredOutputPipeline`, because the parser stage has neither the input nor the config. The wrapper invokes `this.withConfig({ jsonSchema })` with the caller's config and runs the existing safe parse. On a reply that fails JSON parsing, JSON Schema validation or the content parser, it tries to claim repair attempt `n`. When the claim succeeds:
  - Re-invoke the routed model with the original input messages.
  - Append the invalid assistant reply as an `AIMessage` with the same content.
  - Append one fixed `HumanMessage`: `The previous reply did not match the required JSON Schema. Reply again with only JSON that matches the schema.`

  The prompt includes no validator error text. Validation is repeated for each reply. The first valid reply wins.

  The wrapper implements `includeRaw` itself. The result is `{ raw: lastReply, parsed }`, with `parsed: null` only for a fixed `invalid` result, including a per-call limit refusal. This keeps today's behavior. `budget_exceeded` and cancellation are always rethrown. Without `includeRaw`, a final invalid reply throws the fixed `invalid` error.
- R5. Errors stay fixed. A final invalid reply throws the existing fixed `invalid` error with no reply text, validation text or cause. Spans, events, diagnostics and snapshots carry no reply text.

  Repair spans carry only the existing allowlisted attributes. Tests identify repair calls by span count and order. A `galaxie.repair.attempt` attribute is deferred.
- R6. Streaming and abort. A structured call that is aborted mid-repair rejects as an ordinary cancellation. No further repair is dispatched after abort or dispose.
- R7. Direct, unrouted provider-level `withStructuredOutput`, in `packages/models`, is unchanged.

**Tests**

- R8. Add tests in `packages/adapter-langgraph/test` and/or `tests/conformance/structured-output.test.ts`, using new test cases only. Use the scripted chat model to return invalid then valid replies. Cover:
  - no repair by default;
  - one repair succeeding;
  - the per-call limit reached, failing with `invalid` and with the exact number of provider calls;
  - the run-wide budget exhausted, failing with `budget_exceeded` and recording it on the root span;
  - the repair prompt shape: the original messages, then the invalid reply, then the fixed text;
  - `includeRaw` behavior;
  - abort during a repair;
  - token reservations charged for each repair call;
  - no reply text in errors, events, spans, diagnostics or snapshots, checked with a canary.

  `ScriptedChatModel` picks replies by the last human message, and every repair ends with the same fixed text. Use a counting test provider, or extend the test support with a reply sequence, to script invalid, invalid, then valid.

  Run on Node and Chromium. Add budget validation tests for `ModelRoute.repairAttempts` in core.

**Docs**

- R9. Update:
  - system design §8.4: replace "repair attempts remain deferred" and "Repair attempts (2) … reserved for later enforcement" with the contract;
  - `docs/mvp-exit-record.md` row AT-20: cite the new tests, set the status honestly, and keep the note that real-model repair rates are not measured;
  - `docs/unsupported.md`, if it lists repair;
  - the `adapter-langgraph` and `core` `AGENTS.md` files;
  - the AGENTS.md status paragraph.

### Scope Boundaries

- No repair for unrouted models and no repair inside providers.
- No validator-guided prompts.
- No host-local or tutor change. A host opts in through its route configuration. Enabling repair in the examples is out of scope.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Host opt-in per role, enforced by core.** Agent code stays native LangChain, which preserves parity, and repair adds model calls with cost and destination consequences. Making it a route setting keeps the decision with the host, as routing is (ADR-0006). The existing run budget gives the bound that brief §9.4 requires.
- KTD2. **Fixed repair text.** Validator messages can echo reply content. The reply goes back only through the same role's route. `begin` reselects the provider under the run's current labels, consent and destination rules, so a repair call may use a different provider in that route. Document this limit in system design §8.4.

## Implementation Units

- **U1. Core.** R1–R3, with core tests.
- **U2. Adapter repair loop.** R4–R7.
- **U3. Tests.** R8 on Node and Chromium.
- **U4. Docs.** R9.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 to U4 are complete.
- With repair off by default, every existing test passes unchanged.
- The AT-20 row is updated with real evidence.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- Brief §8.6, §9.4 and AT-20.
- `packages/core/src/policy.ts`, `budgets.ts`, `models.ts` and `model-router.ts`.
- `packages/adapter-langgraph/src/routed-chat-model.ts`.
- `tests/conformance/structured-output.test.ts`, `docs/mvp-exit-record.md` and system design §8.4.
