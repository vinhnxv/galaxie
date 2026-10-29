---
title: M3 Storage Lifecycle - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M3 Storage Lifecycle - Plan

## Goal Capsule

- **Objective:** every storage lifecycle case in brief §12.4 has a typed outcome, a test, and no silent data loss:
  - retention;
  - blocked upgrades;
  - corruption;
  - quota errors;
  - missing data;
  - unsupported migrations (an incompatible agent version).

  This is the fourth M3 slice (brief §12.4, §16.5; ADR-0005).
- **Means:**
  - `@galaxie/storage-indexeddb` gains:
    - a retention sweep;
    - a version-change handover;
    - session deletion;
    - an error observation hook;
    - an unrecoverable marker on its errors.
  - Core maps unrecoverable storage failures to `unrecoverable` and refuses to restore a session recorded under another agent version.
  - `examples/host-local` shows the typed outcomes.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0004, ADR-0005, ADR-0009 and ADR-0012. Do not edit any ADR.
  3. This plan.
  4. Brief §12.4 and §16.5.
  5. `docs/system-design.md` §8.
- **Execution profile:** autonomous, in Node and headless Chromium. Work on the existing branch `m3/storage-lifecycle` and open one pull request against `main`. Run U1 to U5 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - an existing test assertion must change;
  - a conformance golden or the compatibility matrix would change;
  - an ADR would change;
  - a dependency would be added at a version not already in `pnpm-lock.yaml`, or any dependency would be upgraded or removed;
  - a case can pass only by deleting data without a host call that asks for it;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Summary

Slices 1 to 3 made sessions durable. Brief §12.4 also requires bounded retention, a safe answer when another tab upgrades the database, and a typed "unrecoverable" result for corrupt data or an incompatible agent version instead of a guess. It also requires visible quota failures, and a clean start when the browser evicted the data. Nothing is deleted except by an explicit host call (`sweep` or `deleteSession`).

### Requirements

**Retention (storage)**

- R1. The saver records a last-activity timestamp for each thread in its scoped `meta` store. It updates the timestamp in the same transaction as every `put`, `putWrites` and recovery write for that session. The clock is `Date.now`, replaceable through an internal test seam that is not exported from the package root. `put` also stores a `savedAt` number from the same clock on each new checkpoint record. `sweep` judges history age by `savedAt`; a record without it counts as older than any cutoff, which is safe because only non-latest checkpoints are pruned.
- R2. `saver.sweep(options?)` resolves `{ prunedCheckpoints, expiredSessions }` as counts. The options are `{ historyMs?, expireMs?, now? }`, with finite defaults of 7 and 30 days.
  1. It removes each thread's checkpoints (and their pending writes) that are older than `historyMs` and are not the latest checkpoint of their namespace. The latest checkpoint per namespace is always kept.
  2. It deletes whole sessions whose last activity is older than `expireMs`: checkpoints, writes, the inbox, the journal and the meta records. A session is one LangGraph thread (`thread_id` equals the session ID). Its last activity is the latest timestamp across that thread's checkpoint, write and recovery records, kept as one per-session value.
  3. Non-finite or negative options reject `StorageError('invalid')`.
  4. It touches only its own app and principal scope, and runs in bounded transactions; one transaction per thread is acceptable.
  5. A sweep that rejects leaves the session it failed on untouched. Sessions already processed stay as processed.

  The host decides when to sweep. Docs say not to sweep a session another tab may be using until slice 5 adds ownership.
- R3. `saver.deleteSession(sessionId)` deletes the same set as an expired session. `deleteThread` keeps its exact `BaseCheckpointSaver` behavior.

**Upgrade handover (storage)**

- R4. Each saver connection handles `versionchange`: it closes the connection at once and moves the saver to a closed state.
  - Every later operation rejects with a new code, `StorageError('superseded')` ("Another version of the app upgraded the storage.").
  - The saver calls an optional `onVersionChange` callback from the open options once, with no arguments.

  A newer opener therefore succeeds instead of reporting `blocked` once the older tabs react. `blocked` remains the result while a connection that does not handle `versionchange` stays open.
- R5. An older package still refuses a newer database version with `newer_schema`, unchanged.

**Errors and observation (storage)**

- R6. `StorageError` instances with code `corrupt`, `newer_schema` or `superseded` carry a read-only own property `unrecoverable: true`. Other codes carry `false`.
  - An optional `onError` open option is called with the fixed `StorageErrorCode`, and nothing else, for every operation that rejects. That way a host observes `quota` or `corrupt` even when the adapter reports the run error as `executor_error`.
  - Callback failures are swallowed.
- R7. Quota: a `QuotaExceededError` from any request or transaction maps to `quota`, as today. It is tested through a test seam that makes a request fail with that `DOMException` name.

**Core**

- R8. Wherever core turns a thrown error into a code in `restore()` and `dispatch`, an error object with own property `unrecoverable === true` maps to `GalaxieError('unrecoverable')` / `toErrorInfo('unrecoverable', error)`.
  - The run `error` event branch maps to `unrecoverable` when `event.error`, or its `cause` when `event.error` is a GalaxieError, has that marker. The LangGraph adapter wraps checkpointer failures as `GalaxieError('executor_error', { cause })`.
  - A conformance case runs the real adapter with a checkpointer whose `put` throws a marked error and expects run error code `unrecoverable`. The error is still reported in diagnostics under the existing host-only rules. No storage import is added to core; the check is structural.
- R9. Agent version check: `RecoveryStore` gains:
  - `recordSession(sessionId, { agentId, agentVersion })`, insert-if-absent: it resolves the stored record, either the existing one or the new one;
  - `session(sessionId)`.

  With a store:
  - `start()` records the definition's ID and version before the start segment begins; a store failure fails `start` with `unavailable`;
  - `restore()` reads the record first. A different ID or version rejects with `GalaxieError('unsupported', …)` with a fixed message, publishes no run and reports `restore_failed`. A missing record cannot prove that the session predates this slice; it may be metadata loss. With a store, `restore()` therefore refuses a missing record with `unsupported` as well. Galaxie has no released sessions from before this slice. Existing slice 3 tests that seed a store without `start()` may add a `recordSession` call to their fixture setup; that is setup, not an assertion change, and the PR records it.

  Migrations are not supported in the MVP; a mismatch is a safe refusal (brief §12.4). Plain strings in returned records follow the slice 3 rule.
- R10. `IndexedDBSaver.recovery` implements both methods in the `meta` store under the session's scope, inside versioned envelopes.

**Host**

- R11. `examples/host-local`:
  - passes `onError` and `onVersionChange`. On version change it shows a fixed "Reload to use the updated app" message and disables input;
  - on `restore()` rejecting `unrecoverable`, shows a fixed "Saved lesson cannot be recovered" message with a "Start over" button. The button calls `saver.deleteSession(sessionId)`, clears the key and shows the start screen. Nothing is deleted until the button is pressed;
  - on `unsupported` (another agent version), keeps today's behavior: it clears the key and starts fresh. The old data stays until a sweep;
  - on a quota observation, shows a fixed "Storage is full" message;
  - sweeps once after the saver opens, with the defaults, before any restore. That is safe because host-local's Web Lock allows one tab per session. A sweep rejection is only observed: `onError` has already reported the code, the sweep is not retried in that page, and restore proceeds.

**Tests and docs**

- R12. Each lifecycle case has a test with a typed result (Verification Contract).
- R13. Docs:
  - the storage README, system design §8 and the error tables describe retention, the handover, the markers, the version check and the host obligations;
  - persistence is not permanence: browsers may evict, and eviction looks like a fresh start;
  - the AGENTS.md and README status sentences are updated.

### Scope Boundaries

- **M3 slice 5:** cross-tab ownership, epochs and bfcache.
- **M3 slice 6:** logout deletion.
- **Not in the MVP:** schema migrations. Database version 1 stays, and nothing upgrades the database in this slice; the handover is tested through the existing internal version seam.

### Assumptions

- Storage errors on the run path arrive at core as an `executor_error` event whose `cause` is the original error. R8 reads the marker there. The `onError` hook also reports the storage code to the host.
- IndexedDB `versionchange` fires on open connections in Chromium when another connection requests a higher version.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Structural `unrecoverable` marker.** Core stays storage-agnostic, and any future store can opt in.
- KTD2. **Deletion only on explicit host calls.** `sweep` and `deleteSession` are the only deleting operations besides `deleteThread`.
- KTD3. **Exact version match.** Restoring under different agent code is refused, not migrated.

### Output Structure

- `packages/storage-indexeddb/src/{saver.ts,schema.ts,errors.ts,recovery.ts,retention.ts,index.ts}` and `test/{retention.test.ts,lifecycle.test.ts}`.
- `packages/core/src/{agent-instance.ts,recovery.ts,errors.ts?}` and `test/lifecycle.test.ts`, plus the slice 3 memory store support.
- `tests/conformance/indexeddb.test.ts` or `tests/conformance/lifecycle.test.ts`.
- `examples/host-local/src/*` and `test/loop.node.test.ts`.
- Docs.

The per-unit file lists are authoritative; widen them only for type fallout, such as fakes implementing the port, and record that in the PR.

### Implementation Constraints

- New files carry the SPDX header. Relative imports end in `.js`, type-only imports use `import type`, exported functions declare return types, and there is no `enum`.
- No new dependencies.

---

## Implementation Units

### U1. Storage errors, observation and handover

- **Files:** `packages/storage-indexeddb/src/{errors.ts,schema.ts,saver.ts,index.ts}`, `test/lifecycle.test.ts`.
- **Coverage:** R4 to R7.
  - The handover path through the version seam: the old saver closes, the new one opens, old operations reject `superseded`, and `onVersionChange` is called once. The newer opener uses the internal `openDatabase(name, appId, otherPrincipal, 2)` seam with a principal scope that has no schema record. The scoped schema-meta check stays unchanged, so a same-scope open at version 2 still reports `corrupt`.
  - A connection without a handler keeps the opener `blocked`.
  - Quota through the seam gives `quota` and `onError('quota')`.
  - Corrupt data gives `onError('corrupt')`, and the markers are set.
  - An older package opening a newer database version still rejects `newer_schema`, with `unrecoverable: true`.

### U2. Retention and session deletion

- **Files:** `packages/storage-indexeddb/src/{retention.ts,saver.ts,recovery.ts}`, `test/retention.test.ts`.
- **Coverage:** R1 to R3.
  - Old history is pruned while the latest checkpoint per namespace is kept.
  - Expired sessions are deleted across all five stores.
  - Fresh sessions and other principals are untouched.
  - Invalid options are rejected.
  - `deleteSession` clears a session.
  - After a sweep, `getTuple` and `list` of the kept checkpoints still match their pre-sweep values.

### U3. Core mapping and version check

- **Files:** `packages/core/src/{agent-instance.ts,recovery.ts}`, `packages/core/test/lifecycle.test.ts`, the memory store support, and `packages/storage-indexeddb/src/recovery.ts` for R10.
- **Coverage:** R8 to R10.
  - An `unrecoverable`-marked error from `pending()`, from a run and from the store maps to `unrecoverable`.
  - Version mismatch is refused with no run.
  - A missing record is refused with `unsupported`.
  - `start()` records the version.

### U4. Conformance and host

- **Files:** `tests/conformance/lifecycle.test.ts` (Chromium-only IndexedDB cases), `examples/host-local/src/*`, `examples/host-local/test/loop.node.test.ts`.
- **Coverage:**
  - Chromium: a corrupted checkpoint record, written through the test seam, makes restore reject `unrecoverable`, and the data stays until `deleteSession`.
  - Chromium: a version bump in the recorded session makes restore reject `unsupported`.
  - Host loop: deleting the IndexedDB database while a key is stored shows the start screen (eviction). Delete it from a fresh page before the app opens its saver, for example with an init script, so the version-change handler does not fire.
  - Host loop: corrupting the checkpoint shows the recovery message, and "Start over" clears it.

  Existing assertions are unchanged.

### U5. Documentation

- **Files:** `packages/storage-indexeddb/README.md`, `docs/system-design.md`, `AGENTS.md`, `README.md`.

---

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Behavior kept | every pre-existing test passes with unchanged assertions | every unit |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr` is empty | before the PR |
| Dependencies | `pnpm install --frozen-lockfile` passes, and the lockfile is unchanged | before the PR |

## Definition of Done

- U1 to U5 are complete.
- Each brief §12.4 case has a test with a typed result: retention, a blocked or superseded upgrade, an older package against a newer schema, corruption, quota, missing data and an incompatible agent version.
- No data is deleted without an explicit host call.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- Brief §12.4 and §16.5; ADR-0005.
- `packages/storage-indexeddb/src/{saver.ts,schema.ts,errors.ts,recovery.ts}` and README.
- `packages/core/src/{agent-instance.ts,recovery.ts,errors.ts}`.
- `examples/host-local/src/{app.tsx,runtime.ts,session.ts}`.
