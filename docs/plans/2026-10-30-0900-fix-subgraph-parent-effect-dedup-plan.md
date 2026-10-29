---
title: Deduplicate Parent Effects Across Subgraph Resume - Plan
type: fix
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Deduplicate Parent Effects Across Subgraph Resume - Plan

## Goal Capsule

- **Objective:** make AT-35 hold: "a subgraph interrupt re-executes the parent node without repeating its effects."
  - `tests/conformance/subgraph-effects.test.ts` shows that a parent node's write-capability call before an interrupting child graph runs twice, with and without recovery.
  - With recovery, the cause is `journalEffectId(sessionId, run.segmentKey, name, ordinal)`. `segmentKey` is `'start'` or the resume interaction ID, so the re-executed parent gets a new effect ID.
  - Key write effects by the LangGraph task that makes the call. The re-executed parent task then reuses its ID, and the recovery journal replays the successful receipt instead of invoking the host again.
- **Means:**
  - the LangGraph adapter passes a task scope with each capability call;
  - core derives write-effect IDs from that scope;
  - the AT-35 characterization becomes a guarantee;
  - docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0002, ADR-0009 and ADR-0012. Do not edit any ADR. If the change would contradict an Accepted ADR's decision text, stop.
  3. This plan.
  4. Brief AT-35, §12.3 and §9.
  5. `docs/system-design.md`, including the recovery section.
- **Execution profile:** autonomous, in Node and headless Chromium. Work offline, except for `git push` and `gh` at the end. Work on the existing branch `closeout2/subgraph-effects`, which holds one commit with this plan. Open one pull request against `main`. Run U1 to U3 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - LangGraph gives no task identifier that stays the same when a pending task is re-executed after resume or after a restore. Verify this first, in U1, with a focused test. If it does not hold, record the evidence and stop.
  - An existing test assertion must change. There are two exceptions:
    - the assertions in `tests/conformance/subgraph-effects.test.ts` that count two host writes with recovery. They become one write with recovery. The count without recovery stays two, because native re-execution has no journal.
    - an assertion that pins the exact inputs of the old effect-ID derivation. If you change one, list it in the PR body with the reason.
  - A golden, the compatibility matrix or an ADR would change.
  - A dependency or `pnpm-lock.yaml` would change.
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

- R1. **Task scope from the adapter.** When agent code calls a capability through the LangGraph host, the adapter derives a stable task scope from the call's `RunnableConfig`.
  - Use the full checkpoint namespace that LangGraph gives the running node, read from `config.configurable.checkpoint_ns` and/or `config.metadata.langgraph_checkpoint_ns`.
  - Verify this against `@langchain/langgraph` in `node_modules`. The namespace must identify the task, including its task ID, and must stay the same when the pending task is re-executed after `Command({ resume })` and after a restore from the checkpointer.
  - Nested subgraph calls have namespaces that include the parent's task segment. Calls inside the child task therefore get their own scope.
  - Pass the scope to core through `CapabilityPort.call` options as an optional field, for example `effectScope?: string`, an opaque string. No caller outside the adapter needs it.
- R2. **Core derives write-effect IDs from the scope.** When a write capability with recovery receives an `effectScope`:
  - the effect ID is `journalEffectId(sessionId, effectScope, name, ordinal)`;
  - `ordinal` counts calls per `(effectScope, name)` within the current run.

  Without a scope, as with calls outside a graph task or from adapters that do not supply one, keep today's derivation from `segmentKey`. Read-capability IDs stay random.
  - Re-execution of the same task in a later run segment therefore produces the same IDs in the same order.
  - The recovery journal's existing replay path returns the successful receipt without invoking the host.
  - A `retry: 'none'` write whose outcome is unknown still fails `outcome_unknown`.
  - Input-digest checking stays: the same ID with different input keeps today's behavior.
- R3. **Determinism and limits.** The `CapabilityContext.effectId` doc comment and system design state the new rule:
  - IDs derive from the session, the graph task scope, the capability name and the per-scope call order;
  - call order within a task must be deterministic;
  - a task that legitimately repeats the same write in a new task gets a new ID.

  Document that this fixes the earlier "repeated start segments in one session reuse IDs" caveat where tasks differ. Remove or revise that caveat only as far as the tests prove it.
- R4. **Tests.**
  - Update `tests/conformance/subgraph-effects.test.ts`: with recovery, there are two parent bodies but one host write, and the second call replays the receipt with the same effect ID. Without recovery, the counts stay at two.
  - Add cases:
    - a restore from the IndexedDB saver in Chromium, with a fresh instance re-executing the pending parent, still makes one host write;
    - two different tasks calling the same write get different IDs;
    - two calls in one task get ordinal-distinct IDs that are stable across re-execution;
    - a nested child task's call is scoped separately from the parent's.
  - Add core unit tests for the scope-keyed ordinal and for the segment fallback.
  - Existing recovery tests must pass unchanged.
- R5. **Docs.** Update:
  - the AT-35 row in `docs/mvp-exit-record.md`, which becomes `automated` if R4 holds, and states that deduplication requires the recovery store;
  - `docs/unsupported.md`: remove the parent-effect entry, or narrow it to the no-recovery case;
  - the system design's recovery section;
  - the `core` and `adapter-langgraph` `AGENTS.md` files;
  - the AGENTS.md status paragraph.

### Scope Boundaries

- No deduplication without a recovery store.
- No change to the recovery store format. If the store must change, stop.
- No backend reconciliation API.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The task, not the run segment, is the unit of re-execution.** LangGraph re-executes pending tasks, not segments. Keying effects by the task's checkpoint namespace matches the native re-execution unit. It reuses the existing journal and replay path with no new storage.

## Implementation Units

- **U1. Verify the stable task identity, then wire the scope.** Write the focused test from the stop conditions first, then R1.
- **U2. Core derivation and tests.** R2–R4.
- **U3. Docs.** R5.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 to U3 are complete.
- A re-executed parent task replays its write receipt under recovery.
- AT-35 is updated honestly.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- `packages/core/src/capability-broker.ts` (`journalEffectId`, `effectOrdinals`, `segmentKey`), `agent-instance.ts:534`, `capabilities.ts` (`CapabilityPort`, `CapabilityContext.effectId`) and `recovery.ts`.
- `packages/adapter-langgraph/src/adapter.ts` (the capability bridge's `call(name, input, config)`).
- `tests/conformance/subgraph-effects.test.ts`, `recovery.test.ts` and `cases/interrupt-subgraph.ts`.
