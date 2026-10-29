---
title: M3 Persistent Inbox, Recovery Reconciliation and Effect Journal - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M3 Persistent Inbox, Recovery Reconciliation and Effect Journal - Plan

## Goal Capsule

- **Objective:** an accepted answer is never lost or applied twice across a crash or reload, and a write capability is never repeated outside its retry contract. Core gains a recovery store port, with:
  - a durable submission inbox;
  - reconciliation in `restore()`;
  - an effect journal for `write` capabilities, with effect IDs derived from the interaction.

  `@galaxie/storage-indexeddb` implements the port in the stores slice 1 reserved, and fault-injection tests cover every crash window. This is the third M3 slice (brief §12.2 steps 5–8, §12.3, §16.5; AT-08, AT-09, AT-31; ADR-0004, ADR-0005).
- **Means:**
  - the port is a core interface;
  - the storage package implements it structurally, without importing core;
  - a test-only in-memory implementation drives the Node tests;
  - conformance fault-injection tests run on Node and Chromium.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0004, ADR-0005, ADR-0009, ADR-0012 and ADR-0014. Do not edit any ADR.
  3. This plan.
  4. Brief §12.2, §12.3 and §16.5.
  5. `docs/system-design.md` §8.1 to §8.3.
- **Execution profile:** autonomous, in Node and headless Chromium. Work on the existing branch `m3/inbox-recovery` and open one pull request against `main`. Run U1 to U6 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - an existing test assertion must change;
  - a conformance golden or the compatibility matrix would change;
  - an ADR would change;
  - a dependency would be added at a version not already in `pnpm-lock.yaml`, or any dependency would be upgraded or removed;
  - a crash-window case can pass only by re-invoking a `retry: 'none'` write whose outcome is unknown;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Summary

Today the inbox is an in-memory map. A reload between "accepted" and the resume checkpoint either loses the answer or lets it be submitted twice. Capability calls also get random effect IDs, so a replayed resume repeats remote writes. This slice makes three things durable:
- the inbox;
- the reconciliation brief §12.2 step 8 specifies;
- a journal of `write` capability calls, so a replay never repeats a write that has a successful receipt, and an unknown outcome is never fired again silently.

### Requirements

**Recovery store port (core)**

- R1. Core exports `RecoveryStore`, a TypeScript interface. Every method is asynchronous and resolves only after its write is durable:
  - `acceptSubmission(sessionId, entry)` is an atomic insert-if-absent keyed by `(sessionId, interactionId)`, and resolves `'accepted' | 'duplicate'`;
  - `consumeSubmission(sessionId, interactionId)`;
  - `submissions(sessionId)`, which lists entries with `status: 'accepted' | 'consumed'`;
  - `effect(sessionId, effectId)`;
  - `recordEffect(sessionId, effectId, record)`.

  An entry holds `interactionId`, `action` and `payload`. Records hold only structured-clone-safe JSON values that the core validated. The store receives the session ID and keeps app and principal scoping in its own keys.
  - Branded core ID types appear only in parameter positions. Data the store returns uses plain `string` IDs and literal-union statuses, because the storage package cannot produce core brands.
  - Core validates and brands every returned record, and treats a malformed one as `unrecoverable`.
- R2. `CreateOptions.recovery?: RecoveryStore`. Without it, behavior is exactly today's: an in-memory inbox, random effect IDs and no journal. All existing tests stay on that path unchanged.
- R3. Docs state the host's obligations:
  - the store must be scoped to the same app and principal as the checkpointer;
  - the store's data is principal data, as private as the checkpoint: it holds learner answers and capability outputs;
  - it stays on-device.

**Inbox (dispatch)**

- R4. With a store, an accepted dispatch persists the entry:
  1. after the existing validation and committed-interrupt check, and before returning the `accepted` receipt and starting the resume segment, call `acceptSubmission`;
  2. `'duplicate'` returns the existing `duplicate` rejection;
  3. a store failure returns a rejection with code `unavailable` and reports `dispatch_failed`, and nothing is started;
  4. after `acceptSubmission` resolves, repeat the `disposing`, `current === run` and `status === 'waiting_input'` checks. If any fails, return `stale` without starting a segment, and leave the accepted entry for the next restore to apply.
- R5. Core calls `consumeSubmission` only when the resume segment yields an `output` event or a new `interaction` event. The adapter emits both only after the engine has drained its checkpoint writes. Core calls it before publishing the consumed status.
  - On `error` events, executor throws, protocol violations and cancellation, the stored entry stays `accepted`, so the next restore re-applies it (R6). LangGraph re-applies a persisted resume value anyway.
  - The in-memory status keeps today's behavior.
  - A consume failure is reported and left for reconciliation; it never fails an otherwise successful run.

**Reconciliation (restore)**

- R6. With a store, `restore()` reads the pending interrupt and the session's submissions, then reconciles them. Reconciliation runs before any snapshot is published.
  - **Accepted entry for the pending `interactionId`:** run the live checks of slice 2 on the pending interaction, then apply the bound payload schema's labels to the stored payload as live dispatch does. Then start a resume segment with the stored action and payload, without UI input. `restore` resolves `{ runId }` with the run `running`.
  - **Accepted entries whose interaction is no longer pending:** mark each consumed. If an interrupt is pending, it renders as in slice 2; otherwise restore resolves `undefined`.
  - **No accepted entry:** behave as slice 2.
  - **More than one accepted entry for the pending interaction:** cannot happen, because the store's insert-if-absent prevents it. If the store returns it anyway, fail with `unrecoverable`.
- R7. A dispatch on a restored run whose `interactionId` has an entry in the store (accepted or consumed) rejects `duplicate`, even though the in-memory map was lost.

**Effect journal (capabilities)**

- R8. With a store, every call to a `kind: 'write'` binding gets a deterministic effect ID. It is a lowercase UUID-shaped string from SHA-256, via `crypto.subtle.digest`, over:
  - the session ID;
  - the segment key: the resume's `interactionId`, or the literal `start` for the start segment;
  - the capability name;
  - the call's ordinal among calls to that name within the segment.

  Brief §12.2 requires code before `interrupt()` to be deterministic, so a replayed segment derives the same IDs. Other kinds keep random effect IDs and no journal.
- R9. Journal states follow brief §12.3: `planned`, `dispatched`, `succeeded` (with the validated output), `failed` and `outcome_unknown`. For a write call with a store:
  1. read the record;
  2. **`succeeded`:** return a fresh copy of the stored output, re-applying output labels and private strings as a live result would, without invoking the binding;
  3. **`dispatched` or `outcome_unknown`:** a previous attempt may have reached the server. Record `outcome_unknown`.
     - With `retry: 'idempotent'` or `'idempotency-key'`, invoke again with the same effect ID.
     - With `retry: 'none'`, fail the call with a new error code, `outcome_unknown` ("The outcome of an earlier call is unknown."), report diagnostic kind `effect_outcome_unknown`, and never invoke.
  4. **no record, `planned` or `failed`:** record `planned` after input validation and policy checks, then record `dispatched` immediately before `invoke`. Each write is durable before the next step.
  5. **After `invoke`:**
     - a validated output records `succeeded`;
     - a host rejection or an abort records `outcome_unknown`, because aborting does not prove the server did nothing (brief §12.3);
     - a validation failure of the output records `outcome_unknown`;
     - a failure before `dispatched` records `failed`.
  6. A journal store failure fails the call with `unavailable` before invoke, or records nothing after invoke and returns the result. That case is reported as `capability_failed` without the result.
  7. **Ordering and input check:**
     - Journal writes for one effect are serialized on a single per-call chain. A record never leaves `succeeded`. An abort or rejection records `outcome_unknown` only if the `succeeded` write has not started; once it has started, its result decides the record.
     - Each record stores a SHA-256 digest of the validated input. A replay whose input digest differs from the stored one fails with `unrecoverable` and never invokes or returns the stored output. This is how a reordering of calls to the same capability is caught.
  8. The `effect_outcome_unknown` diagnostic carries the effect ID, an identifier and no content, so the host can reconcile the effect with its backend.
- R10. The binding receives the effect ID in `CapabilityContext.effectId`, unchanged in shape. Host docs say to send it as the idempotency key.
- R11. No journal or inbox content appears in snapshots, events, spans or diagnostics. Diagnostics keep the host-only `error` rules; spans add only the existing allowlisted outcome codes and the new code.

**Storage**

- R12. `IndexedDBSaver` exposes `saver.recovery`, a `RecoveryStore`-shaped object on the same connection and app/principal scope. It uses the reserved `inbox` and `journal` stores with versioned envelopes like the checkpoint records: records with an unknown `v`, or malformed records, throw `StorageError('corrupt')`, and transactions use the slice 1 barrier. The schema version stays 1. A conformance type test asserts `saver.recovery` is assignable to core's `RecoveryStore`.
- R13. `examples/host-local` passes `recovery: saver.recovery` whenever it passes the saver.

**Tests**

- R14. Fault injection (AT-31) runs in core, using the fake executor with a test-only in-memory store that survives a simulated crash, and in conformance on Node and Chromium with LangGraph `interrupt-resume`. A crash is a runtime dispose while the boundary is held by a test hook.
  - Crash before accept: the interrupt shows again, and one submit resumes once.
  - Crash after accept, before resume: restore resumes automatically with the stored payload; the answer applies once.
  - Crash after the resume checkpoint, before consume: restore marks the entry consumed and does not resume again.
  - Crash after consume: nothing pending, and a re-dispatch of that ID is `duplicate`.
  - A double click before and after a reload is `duplicate` (AT-09).
- R15. Journal tests:
  - crash after `succeeded`, before the checkpoint: the replay returns the stored output and the binding was invoked once;
  - crash after `dispatched`, with `retry: 'none'`: the replay fails `outcome_unknown` and the binding was invoked once;
  - the same with `idempotency-key`: invoked twice with the same effect ID;
  - reads are never journaled;
  - reordering calls to the same capability with different inputs fails `unrecoverable` on replay, through the input digest; deterministic per-capability call order is a replay requirement;
  - a resume that fails, then a restore that resumes the stored answer once;
  - a Chromium test with `saver.recovery` across a reopen covers the inbox and the journal.

**Docs**

- R16.
  - System design §8.1 to §8.3, the error-code list, the storage README and the core contract docs describe the port, reconciliation, the journal states and their limits:
    - there is no host reconciliation API for `outcome_unknown` yet. Restoring that session keeps failing at the same call. A host must reconcile the effect with its backend, using the effect ID the binding received and the diagnostic reports, before it starts a new session that could repeat the logical operation. A new session derives new effect IDs, so galaxie cannot prevent that repeat;
    - a crash in a multi-step resume after an intermediate checkpoint: the interrupt is already resolved, so restore marks the entry consumed and resolves `undefined`. The run cannot finish, and later writes are not replayed;
    - deterministic-order requirement;
    - one tab until slice 5;
    - no epoch check until slice 5;
    - no logout deletion until slice 6;
    - no retention until slice 4.
  - AGENTS.md and README status sentences are updated.

### Scope Boundaries

- **M3 slice 4:** retention, the quota and corruption UX, and the blocked-upgrade handover.
- **M3 slices 5 and 6:** epochs, multi-tab fencing and logout deletion.
- **Later:** a host reconciliation or decision API for `outcome_unknown`, and persisted run labels, budgets and private values. The conservative labels of slice 2 stay.

### Assumptions

- The LangGraph segment settles only after its checkpoint writes complete. ExecutorAgent `run()` documents "Completes only when the engine has settled, including checkpoint writes after an abort". So consuming after settlement satisfies "consumed after the checkpoint is durably committed".
- Adding `outcome_unknown` to `ErrorCode` is a core contract extension, not an ADR change. Update every exhaustive list, message table and test of known codes.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Port in core, implementation in storage.** Core keeps zero runtime dependencies. Storage keeps no core dependency and conforms structurally, checked by a type test.
- KTD2. **Journal only `write`.** Reads may repeat freely, and device and UI kinds are not remote mutations.
- KTD3. **Unknown means unknown.** Every outcome after `dispatched` other than a validated output is `outcome_unknown`. Only an explicit retry policy re-invokes.

### Output Structure

- `packages/core/src/{recovery.ts,agent-instance.ts,capability-broker.ts,errors.ts,runtime.ts,index.ts}`.
- `packages/core/test/{recovery.test.ts,journal.test.ts,support/memory-recovery-store.ts or fake-executor.ts}`.
- `packages/storage-indexeddb/src/{recovery.ts,saver.ts,index.ts}`, `packages/storage-indexeddb/test/recovery.test.ts`.
- `tests/conformance/{recovery.test.ts,indexeddb.test.ts}`.
- `examples/host-local/src/runtime.ts`.
- Docs.

The per-unit file lists are authoritative.

### Implementation Constraints

- New files carry the SPDX header. Relative imports end in `.js`, type-only imports use `import type`, exported functions declare return types, and there is no `enum`.
- No new dependencies. `crypto.subtle` is available on Node 24 and Chromium.

---

## Implementation Units

### U1. Port, error code and inbox persistence

- **Files:** `packages/core/src/{recovery.ts,agent-instance.ts,errors.ts,runtime.ts,index.ts}`, `packages/core/test/recovery.test.ts` and its support store.
- **Coverage:** R1 to R5 and R7.

### U2. Reconciliation in restore

- **Files:** `packages/core/src/agent-instance.ts`, `packages/core/test/recovery.test.ts`.
- **Coverage:** R6 and the core part of R14.

### U3. Effect journal

- **Files:** `packages/core/src/{capability-broker.ts,agent-instance.ts,runtime.ts}`, `packages/core/test/journal.test.ts`. `agent-instance.ts` passes the session ID, the segment key, the store and a per-segment ordinal map through `BrokerRun`; `runtime.ts` gains the diagnostic kind.
- **Coverage:** R8 to R11 and the core part of R15.

### U4. IndexedDB recovery store

- **Files:** `packages/storage-indexeddb/src/{recovery.ts,saver.ts,index.ts}`, `packages/storage-indexeddb/test/recovery.test.ts` (Chromium).
- **Coverage:** R12, including the corrupt-record, abort and reopen cases.

### U5. Conformance fault injection and host wiring

- **Files:** `tests/conformance/{recovery.test.ts,indexeddb.test.ts}`, `examples/host-local/src/runtime.ts`.
- **Coverage:** R13, and the Node, Chromium and IndexedDB parts of R14 and R15. The existing host-local loop must still pass unchanged.
- **Test graph:** no existing case calls a `write` capability, and changing a case would change its golden. Define a test-only LangGraph graph inside `tests/conformance/recovery.test.ts`, not in `cases/` or `golden/`. Its interrupting node calls a `kind: 'write'` binding after `interrupt()` returns, so a replay re-runs it. Run it under each durability mode.
- **Crash hooks:** they must release or fail a held store promise before awaiting dispose; dispose waits up to the 10 s settlement timeout.

### U6. Documentation

- **Files:** `docs/system-design.md` (including the core contract and error-code sections), `packages/storage-indexeddb/README.md`, the TSDoc on `packages/core/src/recovery.ts` and `capabilities.ts`, `AGENTS.md`, `README.md`.

---

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Behavior kept | every pre-existing test passes with unchanged assertions | every unit |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr` is empty | before the PR |
| Dependencies | the lockfile is unchanged or gains only workspace links; `pnpm install --frozen-lockfile` passes | before the PR |

## Definition of Done

- U1 to U6 are complete.
- Every R14 and R15 case passes on its listed lanes.
- No crash window loses an accepted answer or applies it twice, and no `retry: 'none'` write repeats.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- Brief §12.2, §12.3 and §16.5, and the AT-08, AT-09 and AT-31 rows.
- ADR-0004 ("Effect IDs after resume are derived from `interactionId`"), ADR-0005 and ADR-0009.
- `packages/core/src/agent-instance.ts` (`dispatch`, `restore`, segment settlement and `consumed`), `packages/core/src/capability-broker.ts` (the call path and `effectId`), `packages/core/src/capabilities.ts` (`RetryPolicy`, `CapabilityKind`), `packages/core/src/errors.ts`.
- `packages/storage-indexeddb/src/{schema.ts,saver.ts,envelope.ts}`.
- `tests/conformance/{restore.test.ts,indexeddb.test.ts}`.
