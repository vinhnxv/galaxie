# ADR-0005: IndexedDB checkpoint saver for LangGraph.js

- **Status:** Proposed
- **Date:** 2026-10-28
- **Related:** brief §12.1, §12.2, §12.4; ADR-0001, ADR-0004, ADR-0009

## Context

LangGraph.js ships an in-memory saver and savers for server databases. None of them persists in a browser. Recovery after a reload (ADR-0004) needs a durable checkpointer, plus the submission inbox and effect journal next to it.

Correctness depends on more than implementing the methods:

- pending writes;
- checkpoint namespaces and parent checkpoints;
- ordering;
- serialization;
- browser transaction lifetimes;
- whether the engine waits for a checkpoint before it continues.

## Decision

- Implement `BaseCheckpointSaver` (`getTuple`, `list`, `put`, `putWrites`, `deleteThread`) on IndexedDB in `packages/storage-indexeddb`.
- Object stores:
  - checkpoints and pending writes, keyed by thread, checkpoint namespace and checkpoint ID, with indexes for `list`;
  - the submission inbox and the effect journal, in the same database, so they can share a transaction with an epoch check.
- Use the saver's serializer and never store live objects.
- **Durability barrier.**
  - `put` and `putWrites` resolve only after their IndexedDB transaction completes.
  - Use LangGraph's synchronous durability mode where the pinned version offers it (Spike A verifies the modes).
  - The UI never shows a state as committed before its checkpoint is.
- **Namespacing and deletion.**
  - Storage is namespaced per `appId` and principal.
  - Every write checks the owner epoch (ADR-0009) and the logout invalidation generation (ADR-0012) in the same transaction.
  - Shared model assets are stored separately and survive logout.
- **Lifecycle.**
  - Bounded retention of old checkpoints and an expiry for abandoned sessions.
  - A blocked upgrade asks the other tab to close its connection; until then the new version refuses to start.
  - An older package refuses to open a newer schema.
  - A record that fails to deserialize marks the session unrecoverable, with a user-visible message.
- Run the official LangGraph checkpointer conformance tests (the `@langchain/langgraph-checkpoint-validation` package, to verify) in a browser test runner if they can run there. Otherwise port the relevant cases.

## Alternatives considered

- **PGlite (Postgres in WASM) with the Postgres saver.** Rejected for the MVP: several MB of WASM and an unproven browser path.
- **SQLite on OPFS (wa-sqlite) with a ported SQLite saver.** Deferred: the fastest OPFS access is worker-only, and it adds a WASM dependency.
- **In-memory saver plus periodic export.** Rejected: loses pending writes on a crash.

## Consequences

- One more piece of infrastructure to own and keep in sync with LangGraph's saver interface.
- Upgrades need schema migrations or a safe refusal to restore.
- If LangGraph ships an official browser saver, this ADR is superseded (brief §16.8).

## Verification

- Spike A prototype passes the conformance tests, and its durability mode is recorded.
- AT-08, AT-14, AT-31, AT-34; fault injection in M3.
