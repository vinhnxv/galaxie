# @galaxie/storage-indexeddb

An IndexedDB checkpoint saver for LangGraph checkpoint 1.2.0, with per-app and per-principal keys, versioned envelopes and transaction-completion barriers. Its `recovery` port adds a durable submission inbox and write-effect journal. This is a private workspace package.

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

Before publishing a run, restore reconciles submissions with the checkpoint. A matching accepted answer passes current URL/UI, action, payload schema and budget checks, gains the schema's labels/private strings and resumes automatically with status `running`. Resolved entries become consumed; an unanswered interrupt renders normally. With no interrupt, restore returns `undefined`. Dispatch waits for atomic durable acceptance before returning `accepted` or resuming, and existing accepted or consumed records reject `duplicate`. Consumption follows checkpoint-confirmed output or a new interaction; errors and cancellation leave the answer accepted. A failed consume is reported for later reconciliation without failing an otherwise successful run.

The restored run has a fresh run ID and fresh budgets. It conservatively carries every label (`public`, `app`, `private-user`) because prior labels are not persisted; its private-value registry starts empty and is repopulated from accepted payloads and replayed outputs. It uses newly validated grants and opens its first run span on resume. The host-only `restore_failed.error` diagnostic may carry raw error evidence; never forward it to a destination `private-user` may not reach. Core adds no inbox or journal content to diagnostics, snapshots, events or spans.

Host-local passes `saver.recovery` and uses a sessionStorage key containing the app and principal with a Web Lock on that key. Restore begins as soon as a host exists; default-mode model preparation remains manual. Its lock prevents a copied tab from using the session, but supplies no core fencing or owner epochs. Use one tab and one active owner/instance per session until M3 slice 5; journal serialization is per call.

## Storage and durability

Database version remains 1, with `checkpoints`, `writes`, `meta`, `inbox` and `journal`. Recovery uses the previously reserved stores, keyed by app, principal, session and interaction/effect ID. Inbox insertion is atomic across connections, including consumed receipts. Recovery values are validated JSON in `{ v: 1, value }` envelopes; unknown versions or malformed records reject `StorageError('corrupt')`. Successful effect receipts cannot be overwritten.

Checkpoint and write keys contain the app, principal, thread, checkpoint namespace and checkpoint ID; write keys also contain the task and write index. Indexes support thread, namespace and checkpoint queries. Reads use scoped primary-key ranges because IndexedDB omits malformed secondary-index keys; records must be discovered before their routing fields can be validated. Scoped metadata records hold the schema version and monotonic first-insertion order so cross-thread and cross-namespace listing matches `MemorySaver`, including integer-like identifiers.

Checkpoints, metadata and pending-write values pass through the saver's `dumpsTyped`; records retain the returned string type tag and `Uint8Array` bytes in `{ v: 1, type, bytes }` envelopes. The database holds no live graph objects. `loadsTyped` failures, unknown record/envelope versions and missing record fields reject with `corrupt`; reads never return a partially decoded tuple. Changing the serializer requires compatibility with previously stored tags and bytes.

`put`, `putWrites` and recovery writes resolve after the transaction's `complete` event, and aborted transactions reject. Read/write transactions request `durability: 'strict'`, falling back to the browser's default only when transaction options are unsupported. Browser and device behavior still bound physical durability. Use LangGraph's `sync` durability when subsequent effects must wait for a checkpoint; `async` and `exit` retain their native engine behavior.

Direct saver operations reject with `StorageError`, with fixed messages and codes `invalid`, `corrupt`, `newer_schema`, `blocked`, `quota`, `aborted` or `unavailable`. Catch those errors at the direct `open` or saver call. During a runtime run, the adapter reports checkpoint-storage failures as run error events with code `executor_error` and type `StorageError`; it does not preserve the storage subtype code, and a catch around `instance.start()` does not observe those later failures. Core handles recovery-store failures separately as `unavailable`, or malformed returned records as `unrecoverable`; a consume failure does not fail an otherwise successful run. This slice provides no quota/corruption UI. Storage errors contain no keys, thread IDs, stored values or host error text, and never set `cause`. The package emits no spans, events or diagnostics. A blocked open rejects immediately and cancels its queued upgrade when the other connection closes. An older package refuses a newer database version.

## Write replay

The [core write journal](../../docs/system-design.md#83-a-capability-call) records `planned`, `dispatched`, `succeeded`, `failed` and `outcome_unknown`. Only `write` bindings use it. SHA-256 effect IDs derive from session, interaction (or literal `start`), capability name and per-name ordinal; input digests detect changed inputs/order. Keep call order deterministic and send `CapabilityContext.effectId` as the backend idempotency key. Replay returns fresh copies of already validated successful outputs without invoking or rerunning transforms, and reapplies their labels/private strings. Unknown writes replay only under `idempotent` or `idempotency-key`; `retry: 'none'` fails `outcome_unknown` and never invokes again. Aborting a request does not prove the backend did nothing. Journal writes are serialized; once a success write starts, abort cannot overwrite it. A store failure before invoke fails `unavailable`; after invoke it preserves a validated result and reports `capability_failed` without result or raw store-error content.

## Limits

There is no host reconciliation/decision API yet. An unknown `retry: 'none'` write keeps failing at the same call on restore. Reconcile with the backend using the effect ID from the binding or content-free `effect_outcome_unknown` diagnostic before creating a new session that might repeat the logical operation. New sessions derive new IDs, so galaxie cannot prevent that repeat. Repeated start segments within one session reuse literal `start` IDs; use a fresh session/instance for a new logical operation.

Drafts are not persisted. If a multi-step resume crashes after an intermediate checkpoint has resolved the interrupt, restore consumes the entry and returns `undefined`; it cannot finish that run or replay later writes. There is no epoch check or multi-tab fencing until slice 5, no logout deletion/invalidation until slice 6, and no retention, corruption/quota UX or blocked-upgrade handover until slice 4. `deleteThread` deletes only that app's and principal's checkpoints, pending writes and insertion-order records; it leaves inbox/journal records and is not a logout API.

Persistence is not permanence: browsers can evict or clear storage, and quotas apply. For durable or multi-device records, use the host backend or a consented export ([brief §12.4](../../docs/galaxie-project-brief.md#124-storage-limits)). Keep credentials out of graph state and checkpoints. Stored values may include private learner text and answer keys; keep storage on-device and scoped to the authenticated principal and session. This package does not encrypt data or isolate it from other same-origin code.

## Verification

Pure envelope/key/argument tests run on Node and Chromium. Real IndexedDB differential tests in Chromium compare scripted operations against the pinned `MemorySaver`, including ordering, filters, pending writes, special channels, namespaces and deletion. Recovery tests add atomic duplicates, completion barriers, aborted transactions, scope isolation, corrupt envelopes and inbox/journal reopen. A conformance type test checks structural assignability to core's port. The Chromium conformance lane retains all twelve M1 cases with unchanged goldens and matrix differences. Separate fault-injection graphs test inbox crash windows and write retry policies under `async`, `sync` and `exit` on Node and Chromium, including IndexedDB reopen in Chromium. The existing host-local loop still reloads at Quiz and WritingPrompt and completes unchanged. Tests use mock models only; no model weights, real WebLLM bundle or real model APIs are used.
