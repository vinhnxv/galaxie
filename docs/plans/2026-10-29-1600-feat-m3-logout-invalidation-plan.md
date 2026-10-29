---
title: M3 Logout Invalidation Across Tabs - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M3 Logout Invalidation Across Tabs - Plan

## Goal Capsule

- **Objective:** a logout in any tab does three things (brief §9.7 A10, §8.3, §16.5; AT-13; the logout part of AT-34):
  - it bumps an invalidation generation that every tab of the app sees;
  - it wipes the principal's local galaxie storage;
  - it ends that principal's in-flight runs and results in every tab.

  A stale tab can never recreate a deleted record, because every write checks the generation in the same transaction. This is the sixth M3 slice.
- **Means:**
  - `@galaxie/storage-indexeddb` gains a per-principal generation, checked in every write transaction, and `saver.invalidatePrincipal()`, which bumps the generation and wipes the scope in one transaction.
  - `packages/core` gains `watchInvalidation()`, a cross-tab logout notice over a `BroadcastChannel`, and maps invalidated storage failures to `stale`.
  - `fence.current()` also checks the generation, so a page restored from the back/forward cache notices a logout.
  - `examples/host-local` gains a Sign out button.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0005 and ADR-0012. ADR-0009 is Proposed and implemented by slice 5. Do not edit any ADR.
  3. This plan.
  4. Brief §8.3, §9.7 and §16.5.
  5. `docs/system-design.md`.
- **Execution profile:** autonomous, in Node and headless Chromium. Work on the existing branch `m3/logout-invalidation` and open one pull request against `main`. Run U1 to U5 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - an existing test assertion must change;
  - a conformance golden or the compatibility matrix would change;
  - an ADR would change;
  - a dependency would be added at a version not already in `pnpm-lock.yaml`, or any dependency would be upgraded or removed;
  - in any test, a write from a saver opened before the logout commits after it;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Summary

Slice 5 fences a former owner's writes, but a logout is different. It can start in any tab, including one that does not own the app. It must delete the principal's checkpoints, inbox, journal and session metadata, and it must stop every other tab from writing them back. Brief §9.7 A10 requires a generation that every tab sees and that every write checks in its own transaction.

### Requirements

**Storage generation**

- R1. Each principal scope has a generation record in `meta` under `[appId, principalScope, 'generation']`. It is a versioned envelope with an integer `generation`, default 0.
  - Each saver reads the generation at `open` and holds it.
  - The record is not a session record: `sweep`, `deleteSession` and session enumeration ignore it.
- R2. Every read/write transaction checks both values in the same transaction before writing:
  - the epoch, as in slice 5;
  - the held generation, which must equal the stored one.

  On a generation mismatch, the transaction aborts before any write. The operation rejects with `StorageError('invalidated')` ("The principal's storage was invalidated."), which carries own properties `invalidated: true`, `fenced: false` and `unrecoverable: false`, and `onError('invalidated')` is reported. A generation mismatch takes precedence when both values differ. Reads are not checked.
- R3. `saver.invalidatePrincipal(): Promise<void>` runs in one read/write transaction. It is not epoch-checked, because a logout may start in a non-owner tab. In that transaction it:
  - deletes every record in the saver's `[appId, principalScope]` range from `checkpoints`, `writes`, `inbox` and `journal`;
  - deletes every `meta` record in that range except the schema record and the generation record;
  - stores generation + 1.

  It never touches other principals, the app-wide epoch or shared model assets. Afterward, its own saver also rejects writes with `invalidated`, so the host must open a new saver to continue. That reopened saver holds the new generation.
- R4. `saver.fencing.current()` resolves `false` when either the epoch or the generation differs, so slice 5's `pageshow` check notices a logout. `fencing.claim()` checks the generation in its transaction and rejects `invalidated` on a mismatch, so a stale tab cannot take ownership after a logout.

**Core**

- R5. `watchInvalidation({ appId, principalScope })` is exported from `@galaxie/core` and returns `{ signal, announce(): void, close(): void }`.
  - It validates both IDs with the slice 1 pattern; invalid IDs reject `invalid`. A missing `BroadcastChannel` throws `unsupported`.
  - It listens on the `BroadcastChannel` `galaxie:<appId>:invalidation`.
  - `announce()` posts `{ v: 1, type: 'invalidated', principalScope }` and aborts its own `signal` with reason `'invalidated'`.
  - A valid message for the same `principalScope` aborts `signal` with `'invalidated'`. Messages for other principals and malformed messages are ignored.
  - `close()` is idempotent and closes the channel.
- R6. Wherever core maps marked storage errors (`failureCode` and the broker's journal failure path), an error with own `invalidated === true` maps to `stale`. That covers restore, dispatch, run errors and recovery-store failures. The error message table is unchanged.

**Host**

- R7. `examples/host-local`:
  - creates one invalidation watcher per page for its app and learner;
  - adds a "Sign out" button. Its handler awaits `saver.invalidatePrincipal()`, then calls `announce()`, removes the sessionStorage key, disposes the instance and runtime, and releases ownership;
  - on its own or another tab's invalidation signal, the tab disposes, removes its session key and shows the fixed message "Signed out. Reload to continue.". It disables input and does nothing further until reload, and reload opens a fresh saver;
  - when `invalidatePrincipal` fails, it shows a fixed "Sign out failed" message and does not announce;
  - the button's success path and the invalidation signal handler share one idempotent cleanup function. It removes the session key, disposes, releases ownership and shows the status, and it runs once even when `announce()` aborts the page's own signal.
  - Sign out works from a non-owner tab, including a tab that lost ownership and closed its saver. It goes through a new `LocalHost.signOut()`. When the cached saver is missing, closed or disposed, that method opens a short-lived `IndexedDBSaver` for `hostAppId`/`hostLearnerId`, calls `invalidatePrincipal()` on it and closes it. Sign out is shown in every mode, including before models are prepared, because it needs only storage.

**Tests and docs**

- R8. Tests listed in U1 to U4.
- R9. Docs:
  - system design, the storage README, the core contract docs, and the AGENTS.md and README status;
  - the guarantee: no stale write commits after a logout, and every tab is notified when `BroadcastChannel` delivers. Delivery failure is caught by the next write or a `pageshow` check;
  - the limits: a remote request already sent can complete; approvals are invalidated when confirmations ship (M4); the host must also clear its own non-galaxie storage and tokens.

### Scope Boundaries

- **M4:** confirmation and approval invalidation.
- **Not in this slice:**
  - authentication;
  - trace deletion, since no local trace store exists yet;
  - model asset deletion. Logout keeps shared model assets (brief §12).

### Assumptions

- The principal scope ID is a host-derived identifier, not personal content, and the channel is same-origin.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The generation is per principal and the epoch is per app.** A logout invalidates one principal's data; ownership is app-wide.
- KTD2. **A logout is not epoch-checked.** Any tab can delete its principal's data; deletion cannot be fenced into a stuck state.
- KTD3. **A stale write maps to `stale` in core**, which already means "the request targets stale state".

### Output Structure

- `packages/storage-indexeddb/src/{fencing.ts,saver.ts,recovery.ts,retention.ts,errors.ts}`, `test/invalidation.test.ts`.
- `packages/core/src/{invalidation.ts,index.ts,agent-instance.ts,capability-broker.ts}`, `test/invalidation.test.ts`.
- `tests/conformance/invalidation.test.ts`.
- `examples/host-local/src/*`, `test/loop.node.test.ts`.
- Docs.

The per-unit file lists are authoritative; widen them only for type fallout, and record that in the PR.

### Implementation Constraints

- New files carry the SPDX header. Relative imports end in `.js`, type-only imports use `import type`, exported functions declare return types, and there is no `enum`.
- No new dependencies.

---

## Implementation Units

### U1. Storage generation and wipe

- **Coverage:** R1 to R4.
  - After saver B invalidates the principal, every write path of saver A rejects `invalidated`, and nothing is recreated: `put`, `putWrites`, `deleteThread`, the recovery writes, `sweep` and `deleteSession`. Saver B's own later writes reject too.
  - Another principal's records and the epoch are untouched.
  - A fresh saver writes.
  - The schema and generation records survive.
  - A non-owner saver can invalidate, which works without a claim even after another saver claimed.
  - `current()` turns `false`.
  - `fencing.claim()` is also generation-checked: a saver holding an old generation rejects `invalidated` on claim and leaves the epoch unchanged.
  - `sweep` ignores the generation record.

### U2. Core watcher and mapping

- **Coverage:** R5 and R6 on Node: announce, a peer receiving the notice, another principal ignored, malformed messages ignored, an idempotent close, invalid and unsupported options, and marked errors mapping to `stale`.

### U3. Conformance

- **Coverage, Chromium IndexedDB:**
  - Owner A runs the slice 3 or slice 5 test graph and waits on an interrupt.
  - Tab B, which is not the owner, invalidates and announces.
  - A's signal aborts. A late write from A, such as a submission or `recordEffect`, rejects `invalidated`. A's dispose completes without recreating any record.
  - Afterward, no checkpoint, write, inbox or journal record exists for the principal. The principal's `meta` range holds only the schema and generation records.
  - A synthetic `pageshow` on A's ownership aborts it with `stale`.

### U4. Host

- **Coverage:**
  - Sign out in one page shows "Signed out. Reload to continue." in both pages.
  - After reload, the start screen appears with no stored session and no restored lesson.
  - Sign out from the tab that lost ownership to "Use here" succeeds and logs out the other page.
  - A sign-out failure, triggered through a test seam, shows "Sign out failed". A second page receives no invalidation and stays usable.
  - Existing assertions are unchanged.

### U5. Documentation

- **Files:** `docs/system-design.md`, including the core contract and error-code sections; the TSDoc on `packages/core/src/invalidation.ts`; `packages/storage-indexeddb/README.md`, `AGENTS.md` and `README.md`.

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
- A logout in one tab stops every other tab of that principal. No stale write recreates a deleted record, and other principals are untouched.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- Brief §8.3, §9.7 A10 and §16.5; AT-13 and AT-34.
- `packages/storage-indexeddb/src/{fencing.ts,saver.ts,recovery.ts,retention.ts}`, `packages/core/src/{ownership.ts,agent-instance.ts,capability-broker.ts}`.
- `examples/host-local/src/*`.
