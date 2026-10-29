---
title: M3 IndexedDB Checkpoint Saver - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M3 IndexedDB Checkpoint Saver - Plan

## Goal Capsule

- **Objective:** a new package, `packages/storage-indexeddb` (`@galaxie/storage-indexeddb`), provides `IndexedDBSaver`. It implements LangGraph's `BaseCheckpointSaver` over IndexedDB with:
  - the durability barrier;
  - a versioned record envelope;
  - per-app and per-principal namespacing.

  The M1 conformance cases run again with it in Chromium, including a reload: a new saver instance over the same database. This is the first M3 slice (brief §16.5, ADR-0005).
- **Means:** the new package depends only on `@langchain/langgraph-checkpoint` and `@langchain/core` types. Tests have two parts:
  - **Differential tests** against LangGraph's own `MemorySaver`, used as the behavioral oracle, which run in Chromium against real IndexedDB;
  - **A conformance lane** that swaps the saver into the existing Galaxie conformance runner.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0004, ADR-0005, ADR-0009, ADR-0012 and ADR-0016. Do not edit any ADR.
  3. This plan.
  4. Brief §12 (persistence, recovery and storage limits) and §16.5.
  5. `docs/system-design.md` §4 and §8.
- **Execution profile:** autonomous, in Node and headless Chromium. Work on the existing branch `m3/indexeddb-saver` and open one pull request against `main`. Run U1 to U5 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - an existing test assertion must change;
  - a conformance golden or the compatibility matrix would change;
  - an ADR would change;
  - a dependency would be added at a version not already in `pnpm-lock.yaml`, or any dependency would be upgraded or removed;
  - the saver can pass only by storing live objects or skipping the serializer;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Summary

Today every checkpoint lives in memory, so a reload loses the run, including the pending interrupt that is the source of truth for the interaction (ADR-0004). This slice delivers the durable store. Restoring the pending interaction in the UI, the persistent inbox, lifecycle handling, multi-tab fencing and logout are later M3 slices. This slice reserves their place in the schema, and builds none of them.

### Requirements

**The saver**

- R1. `IndexedDBSaver extends BaseCheckpointSaver` from `@langchain/langgraph-checkpoint` 1.2.0, the version already in the lockfile, and implements `getTuple`, `list`, `put`, `putWrites` and `deleteThread`. Its observable behavior equals `MemorySaver`'s at the same version for every operation sequence the tests run:
  - checkpoint lookup by thread, namespace and ID, and latest-checkpoint lookup when no ID is given;
  - `list` ordering, `before`, `limit` and `filter` on metadata;
  - pending writes, including the `taskPath` ordering 1.2.0 documents and the special-write handling for `ERROR`, `INTERRUPT` and similar channels;
  - `parentConfig`.

  Read `MemorySaver`'s source at the pinned version and mirror it. Do not reinterpret it.
- R2. Construction: `IndexedDBSaver.open({ appId, principalScope, databaseName?, serde? })` returns a promise of a ready saver. It is created through a static factory because opening IndexedDB is asynchronous.
  - The database name defaults to `galaxie:<appId>`.
  - Every key includes `appId` and `principalScope`, so two apps or two principals sharing one database never see each other's threads.
  - The host must derive `principalScope` from its authenticated session, never from user-controlled input. The README states this; the saver cannot check it.
  - `appId` and `principalScope` must match `/^[A-Za-z0-9._:-]{1,128}$/`; anything else rejects with a typed error.
  - The saver exposes `close()`.
- R3. Durability barrier: `put` and `putWrites` resolve only after their transaction's `complete` event. They open transactions with `{ durability: 'strict' }` where the browser supports the option. Every rejection maps to a typed error. A transaction abort or error never resolves as success.
- R4. Records hold only serializer output. Each value goes through `this.serde.dumpsTyped`, and the resulting `[type, bytes]` is stored as is, as a string tag plus a `Uint8Array`. No live objects are stored and nothing is cloned structurally. Each record is wrapped in an envelope `{ v: 1, ... }`.
  - On read, an unknown `v`, a missing field or a failed `loadsTyped` throws `StorageError('corrupt')` with a fixed message. It never returns partial data.
  - Marking the session unrecoverable and the user message are slice 4.
- R5. Schema: database version 1 creates the object stores `checkpoints` and `writes`, with indexes for `list` by thread and namespace, plus a `meta` store that records the schema version.
  - It also creates the empty stores `inbox` and `journal`, which slice 3 will fill, so later slices need no upgrade just to add them.
  - Opening a database whose version is newer than the package knows rejects with `StorageError('newer_schema')`.
  - An `onblocked` during open rejects with `StorageError('blocked')` and does not wait. The handover protocol is slice 4.
- R6. Errors: a models-style local error class `StorageError` with `code` values `invalid`, `corrupt`, `newer_schema`, `blocked`, `quota`, `aborted` and `unavailable`.
  - `QuotaExceededError` maps to `quota`.
  - Messages are fixed strings and never include keys, thread IDs or values.
  - `cause` is never set.
  - The package does not depend on `@galaxie/core`, as `packages/models` does not.

**Wiring**

- R7. `@galaxie/adapter-langgraph` already accepts `services.checkpointer`. The saver plugs in there without any adapter change.

**Tests**

- R8. Differential tests run in the Chromium project. Each test uses a fresh, uniquely named database and deletes it afterwards.
  - For a set of scripted operation sequences, the saver and a `MemorySaver` produce equal results from `getTuple`, `list` (with each option) and `deleteThread`, compared after normalizing only object identity.
  - The sequences cover multiple threads, namespaces including subgraph namespaces, interleaved `putWrites`, special writes and `taskPath` ordering.
  - A reopen test closes the saver, opens a new instance on the same database, and reads identical tuples.
  - Differential sequences use only JSON-typed values. `MemorySaver` drops the serde type tag and always decodes as `json`. A separate saver-only test covers the round trip of a `bytes`-typed value.
- R9. Conformance lane: `tests/conformance/support/transcript.ts` gains an optional saver factory parameter for `runGalaxie`, defaulting to the current `MemorySaver`.
  - A new Chromium-only test, `tests/conformance/indexeddb.test.ts`, runs every conformance case with `IndexedDBSaver`. It asserts that the differences against the golden equal those listed for the `galaxie-chromium` lane, without adding a lane to the matrix.
  - **Reload cases at the graph level**, for `interrupt-resume`, `interrupt-subgraph` and both durability cases. A runtime-level reload, where a new instance adopts an existing session, is M3 slice 2, because instances get random session IDs today. Each case:
    1. drives the case through `runGalaxie` with `IndexedDBSaver` until the interrupt;
    2. disposes the runtime and closes the saver;
    3. opens a new `IndexedDBSaver` on the same database;
    4. rebuilds the case graph through its factory, with the native `langgraph.interrupt` driver and the original `thread_id`;
    5. reads the pending interrupt with `getState` and checks it against the paused one;
    6. resumes with `new Command({ resume: { [id]: resume } })`.

    It compares `value`, `answer`, the interrupt ID and value, and `state.next` against the golden. It asserts the `counts` field separately, as the counts the rebuilt graph observes after the resume, because the counters live in factory closures and reset on rebuild.
  - **Repeated resume after a crash.** No M1 baseline exists for this, so this case records the first one:
    1. resume the interrupt to completion and close the saver;
    2. open a new saver, rebuild the graph on the same thread, and resume the same interrupt ID again with `Command`;
    3. assert the observed result as a new baseline: either the final state is unchanged with no extra node execution, or the error type thrown.

    Record the result in the conformance README.

**Docs**

- R10.
  - System design §4 and the package table describe the package.
  - The AGENTS.md project status and the README status gain one sentence each.
  - The package README covers usage and limits:
    - nothing in this slice restores the UI after a reload;
    - there is no inbox, no epoch fencing, no logout deletion, no retention and no blocked-upgrade handover yet;
    - persistence is not permanence (brief §12.4).

### Scope Boundaries

- **M3 slice 2:** restoring the pending interaction in the UI after a reload, and draft persistence.
- **M3 slice 3:** the inbox and journal contents and recovery reconciliation.
- **M3 slice 4:** retention, corruption UX, the blocked-upgrade handover and quota UX.
- **M3 slices 5 and 6:** owner epochs and logout generations.
- **Not in M3:** OPFS and SQLite (ADR-0005 alternatives).

### Assumptions

- `@langchain/langgraph-checkpoint` 1.2.0 is resolvable as a direct dependency of the new package from the lockfile. Its `MemorySaver` is the oracle; `@langchain/langgraph/web` re-exports the same class.
- `@langchain/langgraph-checkpoint-validation` is not in the lockfile. R8's differential tests replace it, as ADR-0005 allows ("Otherwise port the relevant cases").
- Node has no IndexedDB, and `fake-indexeddb` is not in the lockfile. IndexedDB tests therefore run only in Chromium. Node tests cover only pure helpers: key encoding, envelope validation and argument validation.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **`MemorySaver` is the oracle.** The checkpointer contract is subtle, especially pending-write ordering, so equality with LangGraph's own implementation is the strongest available check without new dependencies.
- KTD2. **Composite array keys.** Keys are `[appId, principalScope, threadId, checkpointNs, checkpointId]` arrays, so lookups use key ranges. IndexedDB ordering applies only to checkpoint IDs within one thread and namespace; `MemorySaver` sorts those descending by code unit too.
  - Across threads and namespaces, `MemorySaver` iterates in `Object.keys` order: integer-like keys ascending, then the rest in first-insertion order.
  - The saver therefore stores a monotonic first-insertion sequence for each thread and for each thread namespace, within each app and principal. It writes the sequence on the first `put` and removes it in `deleteThread`, and orders cross-thread and cross-namespace iteration the same way.
  - A differential sequence inserts threads and namespaces in non-lexicographic order, with an integer-like thread ID.
- KTD3. **Reserve the M3 stores now.** Creating `inbox` and `journal` at version 1 lets slice 3 use one shared transaction, with an epoch check later (ADR-0005), without an early schema migration.

### Output Structure

- `packages/storage-indexeddb/{package.json,tsconfig.json,tsconfig.build.json,README.md,src/index.ts,src/saver.ts,src/schema.ts,src/keys.ts,src/envelope.ts,src/errors.ts,test/*.test.ts,test/tsconfig.json}`.
- Root `package.json` scripts (typecheck, typecheck:ts6, build), `vitest.config.ts` (an alias, `@langchain/langgraph-checkpoint` added to the browser project's `optimizeDeps.include`, and include patterns so the package's IndexedDB tests run in the Chromium project and pure tests in Node), `scripts/check-dependencies.ts` (the package's import allowlist and a no-`node:` rule for its `dist`), `pnpm-lock.yaml`.
- `tests/conformance/support/transcript.ts` (the optional saver factory, and both `Object.keys(saver.storage)[0]` lookups replaced by the `thread_id` of the first tuple from `saver.list({})`, typed against `BaseCheckpointSaver`; each case uses a fresh database, so it holds one thread), `tests/conformance/indexeddb.test.ts`, `tests/conformance/package.json`, `tests/conformance/tsconfig.json`.
- Docs.

The tree is a scope declaration; the per-unit file lists are authoritative.

### Implementation Constraints

- New files carry the SPDX header. Relative imports end in `.js`, type-only imports use `import type`, exported functions declare return types, and there is no `enum`.
- Dependencies of the package:
  - `peerDependencies`: `@langchain/langgraph-checkpoint` `~1.2.0` and `@langchain/core` `~1.2.20`;
  - `devDependencies`: those exact lockfile versions.

  `tests/conformance` adds `@galaxie/storage-indexeddb: workspace:*`.
- No `@galaxie/core` dependency.

---

## Implementation Units

### U1. Package scaffold, errors, keys and envelope

- **Files:** `packages/storage-indexeddb/{package.json,tsconfig.json,tsconfig.build.json,src/index.ts,src/errors.ts,src/keys.ts,src/envelope.ts,test/tsconfig.json,test/envelope.test.ts}`, root `package.json`, `vitest.config.ts`, `scripts/check-dependencies.ts`, `pnpm-lock.yaml`.
- **Test scenarios** (Node and Chromium):
  - argument validation rejects invalid scopes with `invalid`;
  - the envelope round-trips;
  - every malformed envelope variant throws `corrupt` with the fixed message.

### U2. Schema and open

- **Files:** `src/schema.ts`, `test/schema.test.ts` (Chromium).
- **Test scenarios:**
  - version 1 creates all five stores and the indexes;
  - opening at a higher stored version rejects with `newer_schema`;
  - a second connection held open during an upgrade yields `blocked`, using a higher test-only version through an internal seam that is not exported from the package root;
  - `close()` is idempotent.

### U3. Saver operations

- **Files:** `src/saver.ts`, `test/saver.test.ts` (Chromium).
- **Test scenarios:** R8.
  - The differential sequences.
  - Principal and app isolation: with the same thread ID, a different `principalScope`, or a different `appId` on the same explicit `databaseName`, keeps `list` and `getTuple` apart, and `deleteThread` removes only that app's and principal's own records.
  - Reopen equality.
  - An aborted transaction, forced through a test seam, rejects `aborted` and leaves no partial write.
  - A deserialization failure throws `corrupt`.

### U4. Conformance lane with IndexedDB

- **Files:** `tests/conformance/support/transcript.ts` (as the Output Structure says), `tests/conformance/indexeddb.test.ts`, `tests/conformance/package.json` (adds `@galaxie/storage-indexeddb: workspace:*` and `@langchain/langgraph-checkpoint: 1.2.0`), `tests/conformance/tsconfig.json`, `tests/conformance/README.md`.
- **Approach:** R9. The existing `galaxie.test.ts` and `native.node.test.ts` stay unchanged and keep the `MemorySaver` default.

### U5. Documentation

- **Files:** `packages/storage-indexeddb/README.md`, `docs/system-design.md`, `AGENTS.md`, `README.md`.

---

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | U2 and later, and before the PR |
| Behavior kept | every pre-existing test passes with unchanged assertions | every unit |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr` is empty | before the PR |
| Dependencies | the lockfile diff adds only the new importer and its links to versions already present; `pnpm install --frozen-lockfile` passes | U1, before the PR |

## Definition of Done

- U1 to U5 are complete, and their tests pass in the stated projects.
- The saver matches `MemorySaver` on every differential sequence, and survives a reopen.
- Every conformance case passes with the IndexedDB saver in Chromium, with the `galaxie-chromium` differences unchanged, and the reload cases resume correctly.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- Brief §12.1 to §12.4 and §16.5; ADR-0004, ADR-0005, ADR-0009 and ADR-0012.
- `node_modules/.pnpm/@langchain+langgraph-checkpoint@1.2.0*/node_modules/@langchain/langgraph-checkpoint/dist/{base.d.ts,memory.js,serde/*}`.
- `packages/adapter-langgraph/src/host.ts` (`services.checkpointer`).
- `tests/conformance/support/transcript.ts` (`runGalaxie`, `galaxieLane`), `tests/conformance/galaxie.test.ts`, `tests/conformance/compatibility-matrix.json`.
- `packages/models/src/errors.ts` (the local error pattern).
