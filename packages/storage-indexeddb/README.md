# @galaxie/storage-indexeddb

An IndexedDB checkpoint saver for LangGraph checkpoint 1.2.0, with per-app and per-principal keys, versioned serializer envelopes and transaction-completion barriers. This private workspace package is the first M3 persistence slice.

## Usage

The host derives `principalScope` from its authenticated session, never from user-controlled input. Both `appId` and `principalScope` must match `/^[A-Za-z0-9._:-]{1,128}$/`. These identifiers partition records within the database; they do not authorize access by other code on the same origin.

```ts
import { IndexedDBSaver, StorageError } from '@galaxie/storage-indexeddb';

const saver = await IndexedDBSaver.open({
  appId: 'lesson-app',
  principalScope, // Derived by the host from its authenticated session.
  // databaseName defaults to 'galaxie:lesson-app'.
  // serde optionally supplies a LangGraph SerializerProtocol.
});

// runtime, definition, graphFactory and input are host-owned.
try {
  const instance = await runtime.create(definition, {
    principalScope,
    agent: graphFactory,
    services: { checkpointer: saver },
  });
  await instance.prepare();
  await instance.start(input);
} catch (error) {
  if (error instanceof StorageError) {
    // Present host-owned UI based on error.code, without displaying stored data.
  }
  throw error;
} finally {
  // Wait for executor settlement before closing the host-owned saver.
  await runtime.dispose();
  saver.close();
}
```

The saver implements `BaseCheckpointSaver`: `getTuple`, `list`, `put`, `putWrites` and `deleteThread`. The adapter already accepts it through `services.checkpointer`; no adapter change is needed. `close()` is idempotent. Opening a new saver with the same database, app and principal reads the same committed checkpoints. The host must also preserve the graph's original `thread_id` and use compatible graph code. Runtime session adoption and UI restoration are not implemented by this package.

## Storage and durability

Database version 1 creates `checkpoints`, `writes`, `meta`, `inbox` and `journal`. The last two stores are empty reservations for later M3 work. Checkpoint and write keys contain the app, principal, thread, checkpoint namespace and checkpoint ID; write keys also contain the task and write index. Indexes support thread, namespace and checkpoint queries. Scoped metadata records hold the schema version and monotonic first-insertion order so cross-thread and cross-namespace listing matches `MemorySaver`, including integer-like identifiers.

Checkpoints, metadata and pending-write values pass through the saver's `dumpsTyped`; records retain the returned string type tag and `Uint8Array` bytes in `{ v: 1, type, bytes }` envelopes. The database holds no live graph objects. `loadsTyped` failures, unknown record/envelope versions and missing record fields reject with `corrupt`; reads never return a partially decoded tuple. Changing the serializer requires compatibility with previously stored tags and bytes.

`put` and `putWrites` resolve after the transaction's `complete` event, and aborted transactions reject. Read/write transactions request `durability: 'strict'`, falling back to the browser's default only when transaction options are unsupported. Browser and device behavior still bound physical durability. Use LangGraph's `sync` durability when subsequent effects must wait for a checkpoint; `async` and `exit` retain their native engine behavior.

All failures use `StorageError` with fixed messages and codes `invalid`, `corrupt`, `newer_schema`, `blocked`, `quota`, `aborted` or `unavailable`. Errors contain no keys, thread IDs, stored values or host error text, and never set `cause`. The package emits no spans, events or diagnostics. A blocked open rejects immediately and cancels its queued upgrade when the other connection closes. An older package refuses a newer database version.

## Limits

This slice does not restore the UI after a reload and does not persist drafts. There is no submission inbox processing, effect journal processing, epoch fencing, logout deletion or invalidation generation, retention, corruption/quota UX, or blocked-upgrade handover yet. Hosts must not treat this saver as the complete M3 recovery or multi-tab protocol. `deleteThread` deletes only that app's and principal's checkpoints, pending writes and insertion-order records; it is not a logout API.

Persistence is not permanence: browsers can evict or clear storage, and quotas apply. For durable or multi-device records, use the host backend or a consented export ([brief §12.4](../../docs/galaxie-project-brief.md#124-storage-limits)). Keep credentials out of graph state and checkpoints. Stored values may include private learner text and answer keys; keep storage on-device and scoped to the authenticated principal and session. This package does not encrypt data or isolate it from other same-origin code.

## Verification

Pure envelope/key/argument tests run on Node and Chromium. Real IndexedDB differential tests in Chromium compare scripted operations against the pinned `MemorySaver`, including ordering, filters, pending writes, special channels, namespaces and deletion. They also cover serializer type tags, close/reopen, isolation, concurrent puts, abort rollback and fixed failures. The Chromium conformance lane reruns all twelve M1 cases with unchanged goldens and matrix differences and rebuilds four interrupted graphs after closing and reopening the saver. Tests use mock models only; no model weights or real model APIs are used.
