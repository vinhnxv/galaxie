# ADR-0009: Multi-tab ownership with Web Locks and a fencing epoch

- **Status:** Proposed
- **Date:** 2026-10-28
- **Related:** brief §8.3, §12.3; ADR-0003, ADR-0004, ADR-0005

## Context

Two tabs of the same app share IndexedDB. If both resume the same session, they can submit twice, write progress twice and each load a multi-GB model into GPU memory.

The first draft relied on `steal` plus an epoch check. An external review pointed out its limits:

- Stealing a Web Lock releases it for the new tab, but it does not stop the old tab's code.
- An epoch check outside the write's transaction leaves a race.
- No local check can recall an HTTP request the old tab already sent.

## Decision

- One owner runtime per `appId` per browser profile, held through the Web Locks API with the lock name `galaxie:<appId>:runtime`. The browser releases the lock when the tab closes.
- A tab without the lock does not load models and does not resume runs. It shows "active in another tab" and offers to take over.
- **Cooperative handover first.**
  - The new tab asks over a `BroadcastChannel`.
  - The owner finishes or cancels in-flight work, records unresolved effects, unloads its engine and releases the lock.
- **Forced takeover** with `steal`, only when the owner does not answer in time.
  - The new tab increments the fencing `epoch` in IndexedDB.
  - The old tab's lock request rejects. It then stops, unloads its engine and goes read-only. Until it notices, it may still be running.
- **Atomic fencing.** Every local write checks the epoch inside the same IndexedDB transaction as the write. A write with a stale epoch never commits.
- **Remote effects.**
  - Effect IDs are persisted before dispatch, so a new owner reuses the same idempotency key.
  - Where a backend needs it, requests carry the epoch and the backend rejects stale epochs.
  - A request the old owner already sent may still complete. The journal marks it `outcome_unknown` until it is reconciled.
- **Back/forward cache.** On `pageshow` with `persisted`, the runtime re-checks the lock, the epoch and the logout invalidation generation before doing anything.

## Alternatives considered

- **Leader election over `BroadcastChannel` only.** Rejected: races, and no automatic release.
- **`localStorage` locks.** Rejected: no automatic release on a crash.
- **`SharedWorker` owner.** Deferred with ADR-0003.
- **Multiple owners with merge (CRDT).** Rejected: far beyond the MVP's needs.

## Consequences

- The guarantee is "at most one owner commits local state", not "never two running tabs".
- A forced takeover can leave remote requests unresolved; the effect journal handles them.
- Every storage write path must check the epoch inside its transaction.

## Verification

- AT-18: cooperative handover and forced takeover in the middle of a run.
- AT-34: a stale tab cannot recreate data deleted by logout.
