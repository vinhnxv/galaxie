# @galaxie/storage-indexeddb

An IndexedDB checkpoint saver for LangGraph checkpoint 1.2.0, with per-app and per-principal keys, versioned serializer envelopes and transaction-completion barriers. This private workspace package is the first M3 persistence slice.

## Usage

The host derives `principalScope` from its authenticated session, never from user-controlled input. Both `appId` and `principalScope` must match `/^[A-Za-z0-9._:-]{1,128}$/`. These identifiers partition records within the database; they do not authorize access by other code on the same origin.

```ts
import { IndexedDBSaver } from '@galaxie/storage-indexeddb';

const saver = await IndexedDBSaver.open({
  appId: 'lesson-app',
  principalScope, // Derived by the host from its authenticated session.
  // databaseName defaults to 'galaxie:lesson-app'.
  // serde optionally supplies a LangGraph SerializerProtocol.
});

// runtime, definition, graphFactory and input are host-owned.
const instance = await runtime.create(definition, {
  principalScope,
  agent: graphFactory,
  services: { chatModels: {}, checkpointer: saver },
});
await instance.prepare();
const { runId } = await instance.start(input);
```

The example assumes a model-free graph. Hosts with model roles supply their existing provider map in `services.chatModels` and the role routing required by their definition. `start()` returns a run ID before execution finishes. Keep the runtime and saver alive while the host handles the run's events, interactions and snapshots; observe execution-time failures through `instance.events(runId)` and the run snapshot.

Only when the host tears down the session, dispose the runtime before closing the saver:

```ts
await runtime.dispose();
saver.close();
```

Disposal cancels a nonterminal run and waits for executor settlement, so it must not run immediately after `start()` unless cancellation is intended.

The saver implements `BaseCheckpointSaver`: `getTuple`, `list`, `put`, `putWrites` and `deleteThread`. The adapter already accepts it through `services.checkpointer`; no adapter change is needed. `close()` is idempotent. Opening a new saver with the same database, app and principal reads the same committed checkpoints. The host must preserve `instance.sessionId` (the graph's `thread_id`) and use compatible graph code. Core provides session adoption and pending-interaction restore; the saver provides its checkpoint storage.

## Restoring a pending interaction

Store `instance.sessionId` per app and authenticated principal when the run reaches `waiting_input`. On reload, open a saver for the same app and principal and give it to a new runtime instance:

```ts
const restored = await runtime.create(definition, {
  principalScope,
  sessionId: storedSessionId,
  agent: graphFactory,
  services: { chatModels: {}, checkpointer: saver },
  // Supply the same host UI bindings and model routing when the definition needs them.
});
await restored.prepare();
const run = await restored.restore();
if (run === undefined) await restored.dispose();
// Render restored.getSnapshot().run.pending through the existing surface when run exists.
```

`storedSessionId` is a `SessionId` from the original instance and must be a lowercase RFC 4122 UUID. Core cannot verify ownership: keep session IDs and the saver's `principalScope` scoped to the same authenticated principal. An adopted instance cannot `start()`; when nothing is pending, dispose it and create a fresh instance for a new run. Restore checks the same URL and UI binding policies as the live interaction path, then dispatch confirms the checkpoint interrupt again before resume.

The restored run has a fresh run ID and fresh budgets. It conservatively carries every label (`public`, `app`, `private-user`) because the prior labels are not persisted; its private-value registry is empty. It uses newly validated grants and opens its first run span on resume. The host-only `restore_failed.error` diagnostic may carry raw error evidence; never forward it to a destination `private-user` may not reach.

Host-local demonstrates this with a sessionStorage key containing the app and principal and a Web Lock on the same key. Restore begins as soon as a host exists; default-mode model preparation remains manual. Its lock prevents a copied tab from using the session, but supplies no core fencing or owner epochs. Use one tab only until M3 slice 5.

## Storage and durability

Database version 1 creates `checkpoints`, `writes`, `meta`, `inbox` and `journal`. The last two stores are empty reservations for later M3 work. Checkpoint and write keys contain the app, principal, thread, checkpoint namespace and checkpoint ID; write keys also contain the task and write index. Indexes support thread, namespace and checkpoint queries. Reads use scoped primary-key ranges because IndexedDB omits malformed secondary-index keys; records must be discovered before their routing fields can be validated. Scoped metadata records hold the schema version and monotonic first-insertion order so cross-thread and cross-namespace listing matches `MemorySaver`, including integer-like identifiers.

Checkpoints, metadata and pending-write values pass through the saver's `dumpsTyped`; records retain the returned string type tag and `Uint8Array` bytes in `{ v: 1, type, bytes }` envelopes. The database holds no live graph objects. `loadsTyped` failures, unknown record/envelope versions and missing record fields reject with `corrupt`; reads never return a partially decoded tuple. Changing the serializer requires compatibility with previously stored tags and bytes.

`put` and `putWrites` resolve after the transaction's `complete` event, and aborted transactions reject. Read/write transactions request `durability: 'strict'`, falling back to the browser's default only when transaction options are unsupported. Browser and device behavior still bound physical durability. Use LangGraph's `sync` durability when subsequent effects must wait for a checkpoint; `async` and `exit` retain their native engine behavior.

Direct saver operations reject with `StorageError`, with fixed messages and codes `invalid`, `corrupt`, `newer_schema`, `blocked`, `quota`, `aborted` or `unavailable`. Catch those errors at the direct `open` or saver call. During a runtime run, the existing adapter reports storage failures as run error events with code `executor_error` and type `StorageError`; it does not preserve the storage subtype code, and a catch around `instance.start()` does not observe those later failures. This slice does not change that adapter contract or provide quota/corruption UI. Storage errors contain no keys, thread IDs, stored values or host error text, and never set `cause`. The package emits no spans, events or diagnostics. A blocked open rejects immediately and cancels its queued upgrade when the other connection closes. An older package refuses a newer database version.

## Limits

Core can now restore pending UI after reload, but drafts are not persisted. Accepted-but-unconsumed submissions are not reconciled until M3 slice 3: a reload between acceptance and the resume checkpoint can show the interaction again, and a second submit resumes it. There is no submission inbox processing, effect journal processing, epoch fencing, logout deletion or invalidation generation, retention, corruption/quota UX, or blocked-upgrade handover yet. Hosts must not treat this saver as the complete M3 recovery or multi-tab protocol. `deleteThread` deletes only that app's and principal's checkpoints, pending writes and insertion-order records; it is not a logout API.

Persistence is not permanence: browsers can evict or clear storage, and quotas apply. For durable or multi-device records, use the host backend or a consented export ([brief §12.4](../../docs/galaxie-project-brief.md#124-storage-limits)). Keep credentials out of graph state and checkpoints. Stored values may include private learner text and answer keys; keep storage on-device and scoped to the authenticated principal and session. This package does not encrypt data or isolate it from other same-origin code.

## Verification

Pure envelope/key/argument tests run on Node and Chromium. Real IndexedDB differential tests in Chromium compare scripted operations against the pinned `MemorySaver`, including ordering, filters, pending writes, special channels, namespaces and deletion. They also cover serializer type tags, close/reopen, isolation, concurrent puts, abort rollback and fixed failures. The Chromium conformance lane reruns all twelve M1 cases with unchanged goldens and matrix differences and rebuilds four interrupted graphs after closing and reopening the saver. Four additional Chromium cases adopt the original core session, call `restore()` and dispatch through the runtime after reopening; Node and Chromium also cover this flow over a shared MemorySaver. The host-local Playwright loop reloads at Quiz and WritingPrompt and completes with mock providers. Tests use mock models only; no model weights or real model APIs are used.
