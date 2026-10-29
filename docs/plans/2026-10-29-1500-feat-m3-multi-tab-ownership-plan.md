---
title: M3 Multi-Tab Ownership and Back/Forward Cache - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M3 Multi-Tab Ownership and Back/Forward Cache - Plan

## Goal Capsule

- **Objective:** at most one tab commits local state for an app (brief §8.3, §16.5; ADR-0009; AT-18). The handover is cooperative first, and a forced takeover fences the old owner atomically. A restored back/forward-cache page checks ownership again before it acts. This is the fifth M3 slice.
- **Means:**
  - `packages/core` gains `acquireOwnership()`: a Web Lock, a `BroadcastChannel` handover, a timed `steal`, a lost signal and a `pageshow` check.
  - `@galaxie/storage-indexeddb` gains a fencing epoch that every write checks inside its own transaction.
  - Core maps a fenced storage failure to `fenced`.
  - `examples/host-local` replaces its session lock with core ownership and offers a takeover.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs: ADR-0004, ADR-0005, ADR-0012 and ADR-0016. ADR-0009 is Proposed and is the design this slice implements. Do not edit any ADR.
  3. This plan.
  4. Brief §8.3, §12.3 and §16.5.
  5. `docs/system-design.md`.
- **Execution profile:** autonomous, in Node and headless Chromium. Work on the existing branch `m3/multi-tab-ownership` and open one pull request against `main`. Run U1 to U5 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - an existing test assertion must change. Changing a test's setup to use the new lock name is allowed; the PR lists each such change;
  - a conformance golden or the compatibility matrix would change;
  - an ADR would change;
  - a dependency would be added at a version not already in `pnpm-lock.yaml`, or any dependency would be upgraded or removed;
  - a fenced former owner can still commit a local write in any test;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Summary

Host-local uses a per-session Web Lock with `ifAvailable`, which keeps a copied tab idle but cannot hand ownership over or stop a stuck owner. ADR-0009 specifies:

- one owner per `appId`, through the lock `galaxie:<appId>:runtime`;
- a cooperative handover over a `BroadcastChannel`;
- a forced `steal` when the owner does not answer;
- an epoch that fences every local write inside the write's own transaction;
- a re-check of ownership on a `pageshow` event with `persisted`.

The guarantee is "at most one owner commits local state", not "never two running tabs". A remote request the old owner already sent can still complete; the effect journal marks it `outcome_unknown`. A new owner reuses the persisted effect ID as its idempotency key.

### Requirements

**Core ownership**

- R1. `acquireOwnership(options)` is exported from `@galaxie/core` and resolves `{ status: 'owner', ownership }` or `{ status: 'busy' }`. The options are:
  - `appId`, matching `/^[A-Za-z0-9._:-]{1,128}$/`;
  - `takeover?: boolean`, default `false`;
  - `handoverTimeoutMs?`, default 5000, finite and positive;
  - `onHandoverRequest: () => Promise<void> | void`, which the owner tab runs before it releases ownership cooperatively;
  - `fence?: { claim(): Promise<void>; current(): Promise<boolean> }`.

  An invalid option rejects `invalid`. A missing `navigator.locks` or `BroadcastChannel` rejects `unsupported`.
- R2. Acquisition:
  1. Request the lock `galaxie:<appId>:runtime` with `ifAvailable`. If it is granted, go to step 4.
  2. If it is not granted and `takeover` is false, resolve `busy`.
  3. If `takeover` is true:
     - post a handover request on the `BroadcastChannel` named the same as the lock;
     - wait for the lock through a normal request whose signal aborts after `handoverTimeoutMs`;
     - on timeout, request it with `steal: true`.
  4. Once the lock is held, await `fence.claim()` before resolving `owner`. If `claim` fails, release the lock and reject `unavailable`.
- R3. `Ownership` exposes:
  - `signal: AbortSignal`. It aborts with a fixed reason `'released' | 'handover' | 'stolen' | 'stale'`, recorded in `ownership.lostReason`, when the lock is released, handed over, stolen, or found stale on `pageshow`;
  - `release(): Promise<void>`, which is idempotent.

  A stolen lock surfaces as a rejection of the owner's own lock request, so `steal` aborts the signal with `stolen`.
- R4. Cooperative handover on the owner side:
  - a valid handover message on the channel runs `onHandoverRequest` once, then releases the lock and aborts the signal with `handover`;
  - a hook rejection still releases the lock; galaxie reports it only as a content-free diagnostic, if a channel exists, or swallows it;
  - concurrent requests run the hook once.

  Messages carry a fixed shape `{ v: 1, type: 'handover' }` and no content; malformed messages are ignored.
- R5. Back/forward cache: while an ownership is live, a `pageshow` event with `persisted === true` runs a check. If the lock request has settled, or `fence.current()` resolves `false` or rejects, the ownership aborts with `stale`. `ownership.verify(): Promise<boolean>` runs the same check on demand. The `pageshow` listener is removed on release or loss.
- R6. Errors:
  - a storage error with own property `fenced === true` maps to `fenced` wherever core already maps marked storage errors (slice 4's `failureCode`): restore, dispatch, run errors and recovery-store failures in the broker;
  - the broker's journal store failure keeps failing the call before invoke, now with `fenced` when marked;
  - `fenced` is an existing `ErrorCode`, so the error message table is unchanged.

**Storage fencing**

- R7. `IndexedDBSaver` keeps one app-wide epoch record in `meta`, shared by every principal scope of the app. It is a versioned envelope with an integer `epoch`, default 0.
  - The key is the single-element array `[appId]`, which lies outside every `[appId, principalScope, …]` prefix range. Sweeps, session deletion and listing therefore never touch it; a test asserts this.
  - Writes in any principal scope check this shared epoch, so a takeover by a tab with a different principal still fences the former owner. Each saver holds an epoch, read at `open`.
  - `saver.fencing.claim()` increments the stored epoch atomically and makes the incremented value the held one.
  - `saver.fencing.current()` resolves whether the stored epoch equals the held one.
- R8. Every read/write transaction reads the stored epoch first, in the same transaction:
  - `put`, `putWrites`, `deleteThread`;
  - every `recovery` write: accept, consume, `recordEffect` and `recordSession`;
  - `sweep` and `deleteSession`.

  If the stored epoch differs from the held one, the transaction aborts before any write, and the operation rejects with `StorageError('fenced')` ("Another tab took over the storage."). It carries own properties `fenced: true` and `unrecoverable: false`. `onError('fenced')` is reported. Reads are not fenced.
- R9. Existing single-saver and reopen behavior is unchanged when no saver claims.

**Host**

- R10. `examples/host-local`:
  - replaces `claimSession` with `acquireOwnership({ appId: hostAppId, fence: saver.fencing, onHandoverRequest })`, held from the same point the session lock was held today until the instance is disposed. The saver is opened before acquisition so `fence` exists;
  - `busy` keeps today's "The lesson is active in another tab." message and adds a "Use here" button that retries with `takeover: true`;
  - the owner's `onHandoverRequest` disposes the runtime;
  - loss means the signal aborted with `handover`, `stolen` or `stale`. On loss, the tab shows the fixed message "The lesson moved to another tab.", disables input and does nothing further until reload. A `released` abort caused by the tab's own `release()` keeps today's behavior and shows no loss message;
  - opening the saver is split from sweeping it. The saver opens without sweeping before `acquireOwnership`. `sweep`, restore and Start over's `deleteSession` run only after acquisition resolves `owner`, which means `fence.claim()` has completed, and while ownership is held.
- R11. Copied sessions keep today's behavior: the existing sessionStorage key stays per tab.

**Tests and docs**

- R12. Tests in the Verification Contract, including AT-18 under both cooperative handover and forced takeover in the middle of a run.
- R13. Docs: system design (ownership flow, guarantees and limits), the storage README (fencing), the core contract docs, and the AGENTS.md and README status. Limits to document:
  - fencing protects local state against a former owner, not against a tab that writes without acquiring ownership;
  - a remote request already sent can complete;
  - a synchronous loop delays noticing loss;
  - Node hosts need both globals.

### Scope Boundaries

- **M3 slice 6:** logout invalidation generation and AT-34.
- **Out of this slice:**
  - a `SharedWorker` owner;
  - backend epoch headers. Docs mention the option, and nothing sends them;
  - engine unload, because no engine is loaded in mock mode. The handover hook is the place for it.

### Assumptions

- `navigator.locks` and `BroadcastChannel` exist in Node 24 and Chromium. Two lock requests and two channels in one page behave like two tabs for these tests.
- A `steal` rejects the previous holder's `navigator.locks.request` promise with an `AbortError`.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The epoch is app-wide**, like the lock in ADR-0009, so a takeover fences the former owner whatever principal either tab uses.
- KTD2. **Fencing is opt-in through `claim`.** Savers that never claim keep today's behavior, so existing tests stay valid. Any claim fences every saver that opened earlier.
- KTD3. **Ownership stays outside `AgentInstance`.** The host composes ownership, saver and runtime. No new `CreateOptions` field.

### Output Structure

- `packages/core/src/{ownership.ts,index.ts,agent-instance.ts,capability-broker.ts}`, `packages/core/test/ownership.test.ts` (Node).
- `packages/storage-indexeddb/src/{fencing.ts,saver.ts,recovery.ts,retention.ts,schema.ts,errors.ts}`, `test/fencing.test.ts`.
- `tests/conformance/ownership.test.ts` (Chromium and IndexedDB).
- `examples/host-local/src/*`, `test/loop.node.test.ts`.
- Docs.

The per-unit file lists are authoritative; widen them only for type fallout, and record that in the PR.

### Implementation Constraints

- New files carry the SPDX header. Relative imports end in `.js`, type-only imports use `import type`, exported functions declare return types, and there is no `enum`.
- No new dependencies.
- Core imports nothing new; `check:deps` stays unchanged.

---

## Implementation Units

### U1. Storage fencing

- **Files:** the storage files above.
- **Coverage:** R7 to R9.
  - Two savers on one scope: after B claims, every write path of A rejects `fenced`, and nothing commits.
  - A's reads still work.
  - B writes.
  - `current()` reflects each saver's state.
  - A fourth saver opened after the claim writes.
  - Concurrent claims serialize, and each claim increments the epoch.
  - Two savers with different principal scopes on one app: B's claim fences A.

### U2. Core ownership

- **Files:** `packages/core/src/ownership.ts`, `packages/core/src/index.ts`, `packages/core/test/ownership.test.ts`.
- **Coverage:** R1 to R5 on Node globals:
  - `busy`, a cooperative handover, the hook running once, a timeout followed by a steal, the lost reasons, an idempotent release, `verify`, and malformed messages ignored;
  - `claim` failure releases the lock, invalid options are rejected, and missing globals give `unsupported`. Missing globals are tested by stubbing them in that test only.
  - Each test uses a unique `appId`, for example one derived from `crypto.randomUUID()`. In Node 24 an aborted queued lock request can briefly hold the lock after a release, so a lock name is never reused after a timeout-and-steal case.

### U3. Core error mapping

- **Files:** `packages/core/src/{agent-instance.ts,capability-broker.ts}`, `packages/core/test/lifecycle.test.ts` or `journal.test.ts`.
- **Coverage:** R6.

### U4. Conformance and host

- **Files:** `tests/conformance/ownership.test.ts`, `examples/host-local/src/*`, `examples/host-local/test/loop.node.test.ts`.
- **Coverage, Chromium AT-18:** use the slice 3 pattern of a test-only LangGraph graph whose interrupting node calls a `kind: 'write'` binding after `interrupt()` returns. Owner A uses saver A; owner B uses saver B on the same scope.
  1. **Forced takeover.** A's binding (`retry: 'none'`) hangs, and A's `onHandoverRequest` never resolves. B takes over after the timeout, claims, and restores.
     - B's run fails `outcome_unknown` without invoking the binding.
     - A's binding then resolves. A's late journal and checkpoint writes, observed through the run, reject `fenced`. Inbox fencing is checked by calling saver A's `recovery.acceptSubmission` and `consumeSubmission` directly after B's claim.
     - The binding ran once.
     - The journal record is `outcome_unknown`, and A's late results never commit.
  2. **Cooperative handover.** A `retry: 'idempotency-key'` binding is used, and A's hook disposes A's runtime. B restores and re-invokes the binding with the same effect ID as A's call, and the run succeeds. The binding writes to a test-local remote stub that deduplicates by effect ID; the test asserts exactly one committed remote effect across both owners.
  3. **bfcache.** A synthetic `pageshow` with `persisted: true` after another saver claimed aborts the ownership with `stale`.
  - The cooperative test sets a `handoverTimeoutMs` and a Vitest timeout above the time the dispose hook needs. It asserts that the takeover was cooperative (`handover`, not `stolen`), so it cannot silently become a forced takeover.
  - Two concurrent LangGraph instances in one page rely on the adapter's context handling. If they interfere because of the synchronous context shim, stop and report it as a blocker, never as a fencing result.
- **Coverage, host loop:**
  - the existing copied-session test passes with its setup moved to the new lock name;
  - "Use here" in a second page makes the first show "The lesson moved to another tab." while the second becomes usable.

### U5. Documentation

- **Files:** `docs/system-design.md`, `packages/storage-indexeddb/README.md`, `AGENTS.md`, `README.md`.

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
- AT-18 holds in Chromium under both a cooperative handover and a forced takeover: no fenced write commits, and no remote effect is duplicated.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- Brief §8.3, §12.3 and §16.5; ADR-0009; AT-18.
- `packages/storage-indexeddb/src/*`, `packages/core/src/{agent-instance.ts,capability-broker.ts,recovery.ts}`.
- `examples/host-local/src/{app.tsx,runtime.ts,session.ts}`, `examples/host-local/test/loop.node.test.ts`.
