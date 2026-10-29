---
title: M3 Restore the Pending Interaction After Reload - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M3 Restore the Pending Interaction After Reload - Plan

## Goal Capsule

- **Objective:** after a page reload, a host can create an instance for an existing session and restore the run that was waiting for input. The run is rebuilt from the pending interrupt in the checkpoint, and its interaction renders through the same snapshot path as before the reload. This is the second M3 slice (brief §12.2 step 4, §16.5; system design §8.2; ADR-0004).
- **Means:** a small core API, adapter-neutral, built on the existing `ExecutorAgent.pending(sessionId)`, and wired in `examples/host-local` with `@galaxie/storage-indexeddb`. Tests cover core with the fake executor, conformance on Node and Chromium, and a Playwright reload loop.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0002, ADR-0004, ADR-0005, ADR-0012 and ADR-0014. Do not edit any ADR.
  3. This plan.
  4. Brief §12.2 and §16.5.
  5. `docs/system-design.md` §8.1 and §8.2.
- **Execution profile:** autonomous, in Node and headless Chromium. Work on the existing branch `m3/restore-pending` and open one pull request against `main`. Run U1 to U5 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - an existing test assertion must change;
  - a conformance golden or the compatibility matrix would change;
  - an ADR would change;
  - a dependency would be added at a version not already in `pnpm-lock.yaml`, or any dependency would be upgraded or removed;
  - restore can work only by weakening a check the live interaction path applies;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Summary

The IndexedDB saver from slice 1 keeps the checkpoint across a reload, but core still gives every instance a fresh random session. A new page therefore cannot find its old thread. This slice adds two things:
- **session adoption:** an instance can be created for an existing session ID;
- **`restore()`:** rebuilds the waiting run from the checkpoint and applies every check that guards a live interaction.

The persistent inbox, recovery reconciliation of accepted submissions, persisted run records and budgets, multi-tab ownership and logout remain later M3 slices.

### Requirements

**Session identity**

- R1. Every instance exposes `instance.sessionId` (`SessionId`), so a host can store it.
- R2. `CreateOptions.sessionId?: SessionId` adopts an existing session instead of minting one.
  - The value must be a lowercase RFC 4122 UUID string, as `crypto.randomUUID()` produces. Anything else rejects at `runtime.create` with `GalaxieError('invalid')` and a fixed message.
  - Core cannot tell whether the session belongs to this principal. The host must store session IDs per app and principal, and must give the instance a checkpointer scoped to the same principal (the IndexedDB saver's `principalScope`). Docs state this.
- R3. An instance created with an adopted `sessionId` cannot `start()`: `start` rejects with `GalaxieError('invalid')`. Starting a new run on an old thread would mix the new input with the old thread's channels. A host that finds nothing to restore disposes the instance and creates a fresh one.

**Restore**

- R4. Signature: `instance.restore(options?: StartOptions): Promise<{ readonly runId: RunId } | undefined>`.
  - Requires state `ready`, no current non-terminal run, and an adapter whose features include `interrupts`, `resume` and `checkpoints`.
  - A wrong state, an active run or a missing feature rejects with the error code `start()` uses for the same condition. For the features that code is `unsupported`.
  - A concurrent second call rejects as a concurrent `start()` would; restore claims the run slot synchronously, as `start()` does.
- R5. Restore reads `executor.pending(sessionId)`.
  - If it returns `undefined`, `restore` releases the slot and resolves `undefined`.
  - If it throws, `restore` rejects with the code the dispatch path uses for the same failure, and reports a `dispatch_failed`-style diagnostic with a new diagnostic kind, `restore_failed`. No run is created.
- R6. Before publishing a pending interaction, restore applies the same checks as the live `interaction` event path, in the same order:
  1. the URL allowlist check, `checkInteractionUrls`;
  2. the UI bindings check, `checkInteractionBindings`, when `ui` is bound.

  A failure rejects `restore` with `denied` or `unsupported` respectively and reports `interaction_rejected`. No run is created and nothing from the props reaches a snapshot or event. Factor the shared checks into one helper used by both paths, so they cannot drift.
- R7. A successful restore creates a run record:
  - a new `runId`: the original run ID is not persisted;
  - status `waiting_input`, with `pending` set to the interaction;
  - grants from `options.grants`, validated exactly as `start()` validates them;
  - **conservative labels**: every `DataLabel` (`public`, `app`, `private-user`), because the labels the run had read before the reload are not persisted;
  - an empty private-value registry;
  - `submittedText` set to `true`;
  - fresh budgets.

  Its event log begins with one `interaction` event equal to what the live path appends, so `events(runId)` replays it. Restore publishes one snapshot and resolves `{ runId }`.
- R8. After restore, `dispatch` and the resume segment work unchanged. Dispatch re-checks the committed interrupt through `executor.pending`, as it does today. The resume segment then runs with the conservative labels.
- R9. Snapshots, events, spans and diagnostics carry no interaction props beyond what the live path already publishes.
  - The restore itself opens no run span. The first span appears with the resume segment, as today.
  - Diagnostics keep the host-only `error` field rules of `DiagnosticEvent`.

**Host**

- R10. `examples/host-local`:
  - keeps `createLocalHost(models)` synchronous, with its current signature;
  - opens `IndexedDBSaver` lazily, once per host, the first time `createInstance` runs. It uses app ID `galaxie-host-local` and principal `hostLearnerId`, and passes the saver as `services.checkpointer`. It does this only when `globalThis.indexedDB` is defined; otherwise it omits the checkpointer, so the adapter keeps its `MemorySaver` and the Node tests stay unchanged. It closes the saver after the host runtime is disposed;
  - leaves `main.tsx`'s exports and the mocked runtime surface used by `test/main.node.test.ts` unchanged;
  - stores the session ID in `sessionStorage` under a key that includes the app ID and the principal, when the run reaches `waiting_input`, and removes it when the run reaches a terminal status;
  - restores as soon as a `LocalHost` exists: on load in the mock build, and right after "Prepare models" succeeds in the default build. It never prepares models automatically;
  - holds a Web Lock (`navigator.locks.request(key, { ifAvailable: true })`, same key) while an instance owns the session. If the lock is unavailable, for example in a duplicated tab whose `sessionStorage` was copied, it neither restores nor starts. It shows a fixed "active in another tab" message and keeps the key. Fencing in core is slice 5;
  - adopts a stored, valid session ID, prepares, and calls `restore()`:
    - **resolves `undefined`, or rejects `denied`, `unsupported` or `invalid`:** the host clears the key, disposes the instance, and shows the normal start screen;
    - **rejects with any other code** (an operational failure such as `unavailable` or `executor_error`): the host keeps the key, disposes the instance, and shows a fixed error with a Retry button that repeats the restore;
  - a restored quiz or writing prompt renders through the existing `AgentSurface`.

  Drafts are not persisted: a reload starts with empty component-local inputs (system design §7).
- R11. The host's default and mock builds keep the strict CSP unchanged. IndexedDB and `sessionStorage` need no CSP directive.

**Tests and docs**

- R12. Tests:
  - core unit tests;
  - conformance tests on Node and Chromium with a shared `MemorySaver` across two runtimes;
  - a Chromium conformance test with `IndexedDBSaver` across a close and reopen;
  - the host-local Playwright loop extended with reloads.

  The Verification Contract lists the cases.
- R13. Docs:
  - system design §8.2 and §4, the core README if one exists, and the package README of `@galaxie/storage-indexeddb` gain the restore flow and its limits:
    - fresh run ID and budgets;
    - conservative labels;
    - accepted-but-unconsumed submissions are not reconciled until slice 3, so a reload between accept and the resume checkpoint shows the interaction again and a second submit resumes it;
    - no drafts;
    - one tab only until slice 5: host-local's Web Lock is a host measure, not core fencing.
  - The AGENTS.md and README status sentences are updated.

### Scope Boundaries

- **M3 slice 3:** the persistent submission inbox and journal, recovery reconciliation, and persisted run records with labels, private values and budgets.
- **M3 slice 4:** retention, corruption and quota UX, and the blocked-upgrade handover.
- **M3 slice 5:** multi-tab ownership, bfcache and owner epochs.
- **M3 slice 6:** logout invalidation.
- **Not in M3:** draft persistence. It stays out until a separate decision under ADR-0014.

### Assumptions

- `ExecutorAgent.pending(sessionId)` in `@galaxie/adapter-langgraph` already reads `graph.getState({ configurable: { thread_id: sessionId } })`, so restore needs no adapter change. If it does need one, keep the change in the adapter and record it in the PR.
- The fake executor in `packages/core/test/fake-executor.ts` can model a pending interaction for `pending()` without a prior run; extend it if not.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Conservative labels instead of persisted labels.** Unknown provenance is treated as the most restrictive. Persisting the real label set belongs with the run record in slice 3, which shares the inbox transaction.
- KTD2. **Adopted sessions restore only.** Forbidding `start()` on an adopted session keeps one thread per run lifecycle without a new reset API.
- KTD3. **One check helper.** The live and restore paths share the URL and UI checks, as system design §8.1 already requires ("Any later path that exposes checkpoint pending state, including M3 reload, must apply the same URL check").

### Output Structure

- `packages/core/src/{agent-instance.ts,instance.ts,runtime.ts,interactions.ts,index.ts}`.
- `packages/core/test/{restore.test.ts,fake-executor.ts}`.
- `tests/conformance/{restore.test.ts,indexeddb.test.ts}`.
- `examples/host-local/{src/*,test/loop.node.test.ts,package.json}`.
- `scripts/check-dependencies.ts`.
- `pnpm-lock.yaml`, importer link only.
- Docs.

The per-unit file lists are authoritative.

### Implementation Constraints

- New files carry the SPDX header. Relative imports end in `.js`, type-only imports use `import type`, exported functions declare return types, and there is no `enum`.
- `examples/host-local` adds `@galaxie/storage-indexeddb: workspace:*`, and `check:deps` allows that import in host-local.

---

## Implementation Units

### U1. Core session adoption and restore

- **Files:** `packages/core/src/{agent-instance.ts,instance.ts,runtime.ts,interactions.ts,index.ts}`, `packages/core/test/{restore.test.ts,fake-executor.ts}`, `packages/react/test/support/fake-instance.ts` (adds a `sessionId` field and a `restore` that resolves `undefined`; no assertion changes).
- **Test scenarios:**
  - `sessionId` exposure and adoption;
  - invalid-format rejection;
  - `start()` rejected on an adopted session;
  - nothing pending resolves `undefined` and leaves the slot free;
  - pending gives a `waiting_input` snapshot with the exact interaction and all three labels;
  - `events(runId)` replays the interaction;
  - a URL-denied interaction rejects `denied`, with no run and no props in the snapshot;
  - an unbound UI component rejects `unsupported`;
  - missing adapter features reject `unsupported`;
  - wrong state and an active run reject;
  - concurrent restore calls;
  - a `pending()` failure rejects with no run;
  - after restore, dispatch accepts and the resume segment completes;
  - a restored run's model or capability call with free text is held to the `private-user` policy.

### U2. Conformance restore on Node and Chromium

- **Files:** `tests/conformance/restore.test.ts`.
- **Approach:** for `interrupt-resume`, `interrupt-subgraph` and both durability cases:
  1. run with one `MemorySaver` to the interrupt and dispose the runtime;
  2. create a new runtime and an adopted instance over the same saver, restore, and dispatch the case's resume value;
  3. compare `value`, `answer`, the interrupt ID and value, and `state.next` with the golden, asserting `counts` separately as in slice 1.

  Use the existing `runGalaxie`/transcript helpers where they fit; add only optional parameters to them.

### U3. Chromium restore with IndexedDB

- **Files:** `tests/conformance/indexeddb.test.ts`.
- **Approach:** the same flow as U2, with `IndexedDBSaver` closed and reopened between the two runtimes.

### U4. Host wiring and reload loop

- **Files:** `examples/host-local/src/*`, `examples/host-local/package.json`, `examples/host-local/tsconfig.json` and `examples/host-local/vite.config.ts` (a `@galaxie/storage-indexeddb` entry pointing at `../../packages/storage-indexeddb/src/index.ts` in `paths` and `resolve.alias`, following the `@galaxie/core` entries; `dist/` is absent in a clean CI checkout), `examples/host-local/test/loop.node.test.ts`, `scripts/check-dependencies.ts`, `pnpm-lock.yaml`.
- **Test scenarios** (mock build, Playwright):
  1. Start the lesson and reload at the quiz. The quiz renders again with the same questions; answer it. Interaction-ID equality is proven in U1 and U2.
  2. Reload at the writing prompt. The prompt renders again with an empty textarea; submit the sentinel sentence.
  3. Feedback and Progress render.
  4. After completion, a reload shows the start screen.
  5. The network capture still has only same-origin GETs and no request carries the sentinel.
  6. Fallbacks:
     - with a stored key whose thread has nothing pending (for example, a session ID written into `sessionStorage` by the test before load), the start screen appears and the key is cleared;
     - a second page in the same context that copies the key while the first holds the lock shows the "active in another tab" message.

  Existing loop assertions are unchanged.

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
| Dependencies | the lockfile diff adds only workspace importer links; `pnpm install --frozen-lockfile` passes | U4, before the PR |

## Definition of Done

- U1 to U5 are complete.
- A reloaded page restores the waiting quiz and writing prompt in the host-local loop and completes the lesson.
- The restore path applies the same URL and UI checks as the live path.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- Brief §12.2 and §16.5; ADR-0004, ADR-0005, ADR-0012 and ADR-0014; system design §7, §8.1 and §8.2.
- `packages/core/src/agent-instance.ts` (`createAgentInstance`, the `interaction` event case, `start`, `dispatch`), `packages/core/src/executor.ts` (`pending`), `packages/core/src/runtime.ts` (`CreateOptions`).
- `packages/adapter-langgraph/src/adapter.ts` (`pending`).
- `packages/storage-indexeddb/README.md`, `tests/conformance/indexeddb.test.ts`.
- `examples/host-local/src/app.tsx`, `src/runtime.ts`, `test/loop.node.test.ts`.
