# @galaxie/storage-indexeddb

An IndexedDB checkpoint saver for LangGraph checkpoint 1.2.0, with per-app and per-principal keys, versioned envelopes and transaction-completion barriers. Its `recovery` port adds a durable submission inbox, write-effect journal and agent identity record. Hosts control retention and session deletion, and observe typed storage failures and upgrade handover. This is a private workspace package.

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
  recovery: saver.recovery,
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

The saver implements `BaseCheckpointSaver`: `getTuple`, `list`, `put`, `putWrites` and `deleteThread`. The adapter accepts it through `services.checkpointer`. `saver.recovery` structurally implements core's [`RecoveryStore`](../../docs/system-design.md#6-core-runtime-and-contracts) on the same connection and scope, without importing core. Supply it whenever durable acceptance and write replay are needed; omitting it keeps core's in-memory inbox, random effect IDs and no journal. `close()` is idempotent. Reopening the same database, app and principal reads the committed checkpoints, submissions and effect receipts. Preserve `instance.sessionId` (the graph's `thread_id`) and use compatible graph code.

## Restoring a pending interaction

Store `instance.sessionId` per app and authenticated principal when the run reaches `waiting_input`. On reload, open a saver for the same app and principal and give it to a new runtime instance:

```ts
const restored = await runtime.create(definition, {
  principalScope,
  sessionId: storedSessionId,
  recovery: saver.recovery,
  agent: graphFactory,
  services: { chatModels: {}, checkpointer: saver },
  // Supply the same host UI bindings and model routing when the definition needs them.
});
await restored.prepare();
const run = await restored.restore();
if (run === undefined) await restored.dispose();
// Render pending through the existing surface; an accepted answer may already be resuming.
```

`storedSessionId` is a `SessionId` from the original instance and must be a lowercase RFC 4122 UUID. Core cannot verify ownership: keep session IDs, checkpointer and recovery store scoped to the same app and authenticated principal. The inbox holds learner answers and the journal holds capability outputs; both are principal data, as private as checkpoints, and must stay on-device. An adopted instance cannot `start()`; when nothing is pending, dispose it and create a fresh instance for a new session.

With a recovery store, `start()` records `{ agentId, agentVersion }` before starting its segment. `recordSession(sessionId, record)` inserts only when absent and returns the stored identity; `session(sessionId)` reads it. Records are validated plain strings inside versioned envelopes in `meta`. A recording failure rejects start with fixed `unavailable` text. Restore reads the identity before checkpoints: a different agent ID or version, or a missing record, rejects `unsupported`, reports `restore_failed` and publishes no run. Missing metadata cannot prove that old code created the session. MVP migrations are not supported; no stored data is deleted by this refusal.

After the version check, restore reconciles submissions with the checkpoint before publishing a run. A matching accepted answer passes current URL/UI, action, payload schema and budget checks, gains the schema's labels/private strings and resumes automatically with status `running`. Resolved entries become consumed; an unanswered interrupt renders normally. With no interrupt, restore returns `undefined`. Dispatch waits for atomic durable acceptance before returning `accepted` or resuming, and existing accepted or consumed records reject `duplicate`. Consumption follows checkpoint-confirmed output or a new interaction; errors and cancellation leave the answer accepted. A failed consume is reported for later reconciliation without failing an otherwise successful run.

The restored run has a fresh run ID and fresh budgets. It conservatively carries every label (`public`, `app`, `private-user`) because prior labels are not persisted; its private-value registry starts empty and is repopulated from accepted payloads and replayed outputs. It uses newly validated grants and opens its first run span on resume. The host-only `restore_failed.error` diagnostic may carry raw error evidence; never forward it to a destination `private-user` may not reach. Core adds no inbox or journal content to diagnostics, snapshots, events or spans.

Host-local passes `saver.recovery` and uses a sessionStorage key containing the app and principal with a Web Lock on that key. Restore begins as soon as a host exists; default-mode model preparation remains manual. Its lock prevents a copied tab from using the session, but supplies no core fencing or owner epochs. Use one tab and one active owner/instance per session until M3 slice 5; journal serialization is per call.

## Storage and durability

Database version remains 1, with `checkpoints`, `writes`, `meta`, `inbox` and `journal`. Recovery uses the previously reserved stores, keyed by app, principal, session and interaction/effect ID. Inbox insertion is atomic across connections, including consumed receipts. Recovery values are validated JSON in `{ v: 1, value }` envelopes; unknown versions or malformed records reject `StorageError('corrupt')`. Successful effect receipts cannot be overwritten.

Checkpoint and write keys contain the app, principal, thread, checkpoint namespace and checkpoint ID; write keys also contain the task and write index. Indexes support thread, namespace and checkpoint queries. Reads use scoped primary-key ranges because IndexedDB omits malformed secondary-index keys; records must be discovered before their routing fields can be validated. Scoped metadata records hold the schema version and monotonic first-insertion order so cross-thread and cross-namespace listing matches `MemorySaver`, including integer-like identifiers.

Checkpoints, metadata and pending-write values pass through the saver's `dumpsTyped`; records retain the returned string type tag and `Uint8Array` bytes in `{ v: 1, type, bytes }` envelopes. The database holds no live graph objects. `loadsTyped` failures, unknown record/envelope versions and missing record fields reject with `corrupt`; reads never return a partially decoded tuple. Changing the serializer requires compatibility with previously stored tags and bytes.

`put`, `putWrites` and recovery writes resolve after the transaction's `complete` event, and aborted transactions reject. Read/write transactions request `durability: 'strict'`, falling back to the browser's default only when transaction options are unsupported. Browser and device behavior still bound physical durability. Use LangGraph's `sync` durability when subsequent effects must wait for a checkpoint; `async` and `exit` retain their native engine behavior.

Direct saver and recovery operations reject with fixed-message `StorageError` values. `open({ onError })` calls the hook once with only the code of each rejected operation, including opening, serialization and validation failures. Observer failures are swallowed. Storage errors contain no keys, thread IDs, stored values or host error text, and never set `cause`. The package emits no spans, events or diagnostics.

| Storage code | Read-only own `unrecoverable` | Meaning |
| --- | --- | --- |
| `corrupt` | `true` | A stored record or envelope cannot be read. |
| `newer_schema` | `true` | The database version is newer than this package supports. |
| `superseded` | `true` | Another app version requested an upgrade; reload is required. |
| `blocked` | `false` | A connection that has not closed still blocks an upgrade. |
| `quota` | `false` | A request or transaction exceeded browser storage quota. |
| `aborted` | `false` | The transaction was aborted. |
| `invalid` | `false` | A storage request or retention option is invalid. |
| `unavailable` | `false` | Storage or serialization failed for another reason. |

On `versionchange`, the saver closes immediately, rejects later storage operations with `superseded` and calls `onVersionChange()` once with no arguments. Hosts should show a fixed reload message and disable input. A newer opener can then proceed. A connection without a handler still produces `blocked`; that open rejects immediately and cancels its queued upgrade when the blocking connection closes. An older package still refuses a newer database version. This slice keeps database version 1 and performs no schema migration.

Core recognizes an own data property `unrecoverable === true` structurally, without importing storage. Restore and dispatch map marked failures to `unrecoverable`. The run error path also recognizes a marked storage error wrapped as an adapter `GalaxieError` cause. Other checkpoint failures remain `executor_error`; other recovery-store failures remain `unavailable`. Malformed returned recovery records are `unrecoverable`. A catch around `start()` does not observe later run failures: use run events/snapshots and the storage observation hook. Raw failures stay in the existing host-only `DiagnosticEvent.error` field; never forward them to a destination `private-user` may not reach. A failed consume remains a diagnostic for later reconciliation without failing an otherwise successful run.

## Host-controlled retention and deletion

Nothing is swept automatically by the saver. After obtaining exclusive session ownership, the host can explicitly call:

```ts
const result = await saver.sweep();
// result: { prunedCheckpoints, expiredSessions }
await saver.deleteSession(sessionId); // Only when the host explicitly requests deletion.
```

`sweep({ historyMs?, expireMs?, now? })` defaults to 7 days of checkpoint history and 30 days of session inactivity. All supplied values must be finite, non-negative numbers; invalid options reject `invalid`. Each `put` records `savedAt`, and `put`, `putWrites` and recovery writes update the session's last activity in the same transaction. Activity is the latest write timestamp, even if the clock moves backward.

The sweep prunes checkpoints older than `historyMs`, always keeping the latest checkpoint in each namespace. Checkpoints without `savedAt` count as older than every cutoff. Associated pending writes are removed, except parent `TASKS` writes referenced by retained checkpoints: legacy pre-v4 tuples need them for identical reads. The sweep marks these preserved rows internally and reclaims them on later sweeps once no retained checkpoint needs them. Unmarked writes for checkpoints not yet stored remain untouched. Expired sessions lose their checkpoints, pending writes, inbox, journal and session metadata. `deleteSession` removes that same session data explicitly. Both operations stay within the saver's app/principal scope. Sweep deletion runs in one transaction per session; a rejected session transaction leaves that session untouched, while earlier completed sessions stay processed. Legacy sessions without activity metadata are not expired by an assumed age.

Until slice 5 adds ownership and fencing, do not sweep a session another tab may be using. Host-local holds its app/principal Web Lock before opening and sweeping once with defaults, before restore. A sweep failure is observed without retrying in that page, and restore proceeds. Quota observations show "Storage is full"; handover shows "Reload to use the updated app" and disables input. An unrecoverable restore keeps the session and shows "Saved lesson cannot be recovered" with "Start over". Only that button deletes the session, under the same Web Lock, then clears the key. An unsupported agent version clears only the key and returns to Start; old data remains until a host sweep.

## Write replay

The [core write journal](../../docs/system-design.md#83-a-capability-call) records `planned`, `dispatched`, `succeeded`, `failed` and `outcome_unknown`. Only `write` bindings use it. SHA-256 effect IDs derive from session, interaction (or literal `start`), capability name and per-name ordinal; input digests detect changed inputs/order. Keep call order deterministic and send `CapabilityContext.effectId` as the backend idempotency key. Replay returns fresh copies of already validated successful outputs without invoking or rerunning transforms, and reapplies their labels/private strings. Unknown writes replay only under `idempotent` or `idempotency-key`; `retry: 'none'` fails `outcome_unknown` and never invokes again. Aborting a request does not prove the backend did nothing. Journal writes are serialized; once a success write starts, abort cannot overwrite it. A store failure before invoke fails `unavailable`; after invoke it preserves a validated result and reports `capability_failed` without result or raw store-error content.

## Limits

There is no host reconciliation/decision API yet. An unknown `retry: 'none'` write keeps failing at the same call on restore. Reconcile with the backend using the effect ID from the binding or content-free `effect_outcome_unknown` diagnostic before creating a new session that might repeat the logical operation. New sessions derive new IDs, so galaxie cannot prevent that repeat. Repeated start segments within one session reuse literal `start` IDs; use a fresh session/instance for a new logical operation.

Drafts are not persisted. If a multi-step resume crashes after an intermediate checkpoint has resolved the interrupt, restore consumes the entry and returns `undefined`; it cannot finish that run or replay later writes. There is no epoch check or multi-tab fencing until slice 5, and no logout deletion/invalidation until slice 6. `deleteThread` keeps its `BaseCheckpointSaver` behavior: it deletes only that app's and principal's checkpoints, pending writes and insertion-order records, leaving recovery records and activity metadata. It is not a session or logout deletion API.

Persistence is not permanence: browsers can evict or clear storage, and quotas apply. Eviction looks like a fresh start: host-local clears the stored key when session metadata or pending state is absent. For durable or multi-device records, use the host backend or a consented export ([brief §12.4](../../docs/galaxie-project-brief.md#124-storage-limits)). Keep credentials out of graph state and checkpoints. Stored values may include private learner text and answer keys; keep storage on-device and scoped to the authenticated principal and session. This package does not encrypt data or isolate it from other same-origin code.

## Verification

Pure envelope/key/argument tests run on Node and Chromium. Real IndexedDB differential tests in Chromium compare scripted operations against the pinned `MemorySaver`, including ordering, filters, pending writes, special channels, namespaces and deletion. Recovery tests add atomic duplicates, completion barriers, aborted transactions, scope isolation, corrupt envelopes, session identity and inbox/journal reopen. Lifecycle tests cover retention, rollback, blocked/superseded upgrades, newer schemas, corruption, quota, eviction and incompatible agent versions. A real-adapter marked checkpoint failure maps to `unrecoverable` on Node and Chromium. A conformance type test checks structural assignability to core's port. The Chromium conformance lane retains all twelve M1 cases with unchanged goldens and matrix differences. Separate fault-injection graphs test inbox crash windows and write retry policies under `async`, `sync` and `exit` on Node and Chromium, including IndexedDB reopen in Chromium. The existing host-local loop still reloads at Quiz and WritingPrompt and completes unchanged. Tests use mock models only; no model weights, real WebLLM bundle or real model APIs are used.
