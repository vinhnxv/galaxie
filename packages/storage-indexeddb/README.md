# @galaxie/storage-indexeddb

An IndexedDB checkpoint saver for LangGraph checkpoint 1.2.0, with per-app and per-principal keys, versioned envelopes and transaction-completion barriers. Its `recovery` port adds a durable submission inbox, write-effect journal and agent identity record. Hosts control retention and session deletion, and observe typed storage failures and upgrade handover. This is a private workspace package.

## Usage

The host derives `principalScope` from its authenticated session, never from user-controlled input. Both `appId` and `principalScope` must match `/^[A-Za-z0-9._:-]{1,128}$/`. These identifiers partition records within the database; they do not authorize access by other code on the same origin.

```ts
import { acquireOwnership } from '@galaxie/core';
import { IndexedDBSaver } from '@galaxie/storage-indexeddb';

const saver = await IndexedDBSaver.open({
  appId: 'lesson-app',
  principalScope, // Derived by the host from its authenticated session.
  // databaseName defaults to 'galaxie:lesson-app'.
  // serde optionally supplies a LangGraph SerializerProtocol.
});

// runtime, definition, graphFactory and input are host-owned.
const acquired = await acquireOwnership({
  appId: 'lesson-app',
  fence: saver.fencing,
  onHandoverRequest: () => runtime.dispose(),
});
if (acquired.status === 'busy') {
  saver.close();
  throw new Error('The lesson is active in another tab.');
}
const ownership = acquired.ownership;
// On ownership.signal abort, disable host input and dispose the runtime.
// Only 'released' means this host deliberately released it.
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
await ownership.release();
saver.close();
```

Disposal cancels a nonterminal run and waits for executor settlement, so it must not run immediately after `start()` unless cancellation is intended.

The saver implements `BaseCheckpointSaver`: `getTuple`, `list`, `put`, `putWrites` and `deleteThread`. The adapter accepts it through `services.checkpointer`. `saver.recovery` structurally implements core's [`RecoveryStore`](../../docs/system-design.md#6-core-runtime-and-contracts) on the same connection and scope, without importing core. Supply it whenever durable acceptance and write replay are needed; omitting it keeps core's in-memory inbox, random effect IDs and no journal. `close()` is idempotent. Reopening the same database, app and principal reads the committed checkpoints, submissions and effect receipts. Preserve `instance.sessionId` (the graph's `thread_id`) and use compatible graph code.

## Python byte checkpoints

For the Python adapter, pass `services: { chatModels, checkpoints: saver.byteRecords }`
and `recovery: saver.recovery`. Compile a LangGraph Python graph with
`galaxie.langgraph.checkpointer()`; the pydantic-ai driver instead snapshots its
conversation at pauses and completion. The Worker serializes checkpoints and pending
writes; JavaScript stores their opaque bytes in the existing version-1 envelopes
and key layout, marked with the closed set `langgraph-python | pydantic-ai-python`.
The adapter supplies its executor ID on port requests; an omitted ID retains the
original `langgraph-python` contract. Reads select the requested executor's rows,
and existing LangGraph bytes remain readable without a rewrite. The JavaScript saver's
`getTuple` and `list` skip these marked records. No storage schema or version changes.

`byteRecords.request(value)` accepts the closed operations `get`, `list`, `put`,
`put-writes` and `delete`, all with a `sessionId`. Reads and writes use `namespace`
(and checkpoint `id` where needed); `list` optionally filters `namespace`, `id`,
`before` and `limit`. A `put` supplies `parentId`, `timestamp`, `checkpoint` and
`metadata`; each serialized value is `{ type, bytes: Uint8Array }`. `put-writes`
supplies `taskId`, `taskPath` and writes with `channel`, `index`, serialized `value`
and `interruptIds`. The Python saver derives these fields from committed engine
state. A tuple returns its checkpoint, metadata, writes and parent writes. `delete`
removes the thread's checkpoints and writes; `deleteSession` also removes recovery
records. Base64 appears only on the Worker bridge.

The port uses the same fenced write helpers, app/principal scope, retention,
explicit deletion and principal wipe as the JavaScript saver. Export reads marker
timestamps and interrupt IDs without invoking the JavaScript serializer. An explicit
personal-content export copies each checkpoint's stored executor tag and represents
serialized values as their type tag and marked
base64 bytes; it does not deserialize Python objects. A tuple or list must fit the
bridge's 1 MiB limit after base64 encoding, or the operation fails `unsupported`.
Hosts still compose ownership and dispose the runtime before closing the saver.

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

With a recovery store, `start()` records `{ agentId, agentVersion, executorId }` before starting its segment. `recordSession(sessionId, record)` inserts only when absent and returns the stored identity; `session(sessionId)` reads it. Records are validated plain strings inside versioned envelopes in `meta`. A recording failure rejects start with fixed text: `stale` for invalidated principal storage, otherwise `unavailable`. Restore reads the identity before checkpoints: a different agent ID or version, or a missing record, rejects `unsupported`, reports `restore_failed` and publishes no run. Missing metadata cannot prove that old code created the session. MVP migrations are not supported; no stored data is deleted by this refusal.

The executor ID comes from the adapter. A different executor rejects restore with `unsupported` and "The saved session uses a different executor." before pending-state reads or inbox reconciliation. Legacy two-key IndexedDB identities read as `langgraph-js`, without a rewrite or database upgrade; new writes and other recovery stores require all three non-empty strings. Export includes `metadata.agent.executorId`.

After the identity check, restore reconciles submissions with the checkpoint before publishing a run. A matching accepted answer passes current URL/UI, action, payload schema and budget checks, gains the schema's labels/private strings and resumes automatically with status `running`. Resolved entries become consumed; an unanswered interrupt renders normally. With no interrupt, restore returns `undefined`. Dispatch waits for atomic durable acceptance before returning `accepted` or resuming, and existing accepted or consumed records reject `duplicate`. Consumption follows checkpoint-confirmed output or a new interaction; errors and cancellation leave the answer accepted. A failed consume is reported for later reconciliation without failing an otherwise successful run.

The restored run has a fresh run ID and fresh budgets. It conservatively carries every label (`public`, `app`, `private-user`) because prior labels are not persisted; its private-value registry starts empty and is repopulated from accepted payloads and replayed outputs. It uses newly validated grants and opens its first run span on resume. The host-only `restore_failed.error` diagnostic may carry raw error evidence; never forward it to a destination `private-user` may not reach. Core adds no inbox or journal content to diagnostics, snapshots, events or spans.

Host-local passes `saver.recovery` and keeps its app/principal sessionStorage key per tab. It opens the saver before acquiring core ownership on `galaxie:galaxie-host-local:runtime`, without sweeping. Only after `fence.claim()` completes may it sweep, restore or delete a session. A busy tab offers "Use here"; a former owner shows "The lesson moved to another tab." and disables input until reload. The handover hook disposes the runtime before releasing ownership. Default-mode model preparation remains manual.

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
| `fenced` | `false` | Another tab claimed the app epoch; no write committed. |
| `invalidated` | `false` | The principal generation changed; no write committed. |
| `blocked` | `false` | A connection that has not closed still blocks an upgrade. |
| `quota` | `false` | A request or transaction exceeded browser storage quota. |
| `aborted` | `false` | The transaction was aborted. |
| `invalid` | `false` | A storage request or retention option is invalid. |
| `unavailable` | `false` | Storage or serialization failed for another reason. |

On `versionchange`, the saver closes immediately, rejects later storage operations with `superseded` and calls `onVersionChange()` once with no arguments. Hosts should show a fixed reload message and disable input. A newer opener can then proceed. A connection without a handler still produces `blocked`; that open rejects immediately and cancels its queued upgrade when the blocking connection closes. An older package still refuses a newer database version. This slice keeps database version 1 and performs no schema migration.

Core recognizes own data properties `invalidated === true`, `fenced === true` and `unrecoverable === true` structurally, without importing storage. Invalidation takes precedence and maps to `stale`, including session recording, restore, dispatch, run errors and journal failures after invocation. Its fixed storage message is "The principal's storage was invalidated."; the error has read-only own properties `invalidated: true`, `fenced: false` and `unrecoverable: false`, and reports `onError('invalidated')`. A fenced storage error has read-only own properties `fenced: true` and `unrecoverable: false`, reports `onError('fenced')`, and maps to core `fenced` in restore, dispatch, run errors and broker journal failures. Restore and dispatch map `unrecoverable` markers to `unrecoverable`. The run error path also recognizes a marked storage error wrapped as an adapter `GalaxieError` cause. Other checkpoint failures remain `executor_error`; other recovery-store failures remain `unavailable`. Malformed returned recovery records are `unrecoverable`. A catch around `start()` does not observe later run failures: use run events/snapshots and the storage observation hook. Raw failures stay in the existing host-only `DiagnosticEvent.error` field; never forward them to a destination `private-user` may not reach. A failed consume remains a diagnostic for later reconciliation without failing an otherwise successful run.

## App-wide fencing

`saver.fencing.claim()` atomically increments a versioned `{ v: 1, epoch }` record in `meta` and holds that epoch on the connection. `current()` reports whether both the stored epoch and the principal generation still match. A claim checks the generation before changing the epoch; an invalidated saver cannot reclaim ownership. Each saver reads the epoch at open (default 0); savers that never claim retain single-saver and reopen behavior. A saver opened after a claim holds the current epoch, but the host must still acquire ownership before using it.

The epoch key is `[appId]`, outside every `[appId, principalScope, ...]` range. Claims fence earlier savers across all principals of the app in that database. Session listing, sweep and deletion preserve the epoch record. Every `put`, `putWrites`, `deleteThread`, recovery write, sweep write and `deleteSession` checks the principal generation, then the epoch, inside the write's own transaction. An epoch mismatch aborts before mutation with `StorageError('fenced')`, "Another tab took over the storage." Reads are not fenced.

Compose the fencing port with core ownership; claiming alone does not hold a Web Lock. Fencing protects local state from a former owner, not from a tab that writes without acquiring ownership. An already-sent remote request can complete; reuse the persisted effect ID as its idempotency key. Backends may implement their own epoch checks, but this slice sends no epoch headers. A synchronous loop delays noticing loss. Core verifies a persisted `pageshow` and offers `ownership.verify()`; Node hosts need both `navigator.locks` and `BroadcastChannel`.

## Principal logout

Each saver holds the principal generation read at open. The versioned `{ v: 1, generation }` record lives at `[appId, principalScope, 'generation']` in `meta`, defaulting to 0. Session enumeration, sweep and `deleteSession` ignore it. Every mutation checks the held generation in its own transaction before any write, including epoch claims. A mismatch aborts with `invalidated`, even if the epoch also changed. Reads remain available.

`saver.invalidatePrincipal()` needs no ownership or epoch claim: a non-owner tab can log out. One transaction increments the current generation and deletes the principal's entire range in `checkpoints`, `writes`, `inbox` and `journal`, plus all scoped `meta` records except schema and generation. It preserves other principals, the app-wide epoch and shared model assets. On failure the whole wipe rolls back. The initiating saver is invalidated too; open a new saver to continue. No state write from an earlier saver can commit after the logout transaction.

Create one core `watchInvalidation({ appId, principalScope })` per page. Await `saver.invalidatePrincipal()` before calling the watcher's `announce()`. Its own signal and matching peer signals abort with `'invalidated'`. The host must then disable input, clear its session key, dispose its instance/runtime and release ownership through one idempotent cleanup. Close the watcher on page teardown. If the wipe fails, show a fixed failure and do not announce. Host-local's Sign out is available before model preparation and after losing ownership; it opens a short-lived saver when no usable saver remains, then requires reload to continue.

Broadcast delivery notifies peer tabs when delivered; a missed notice is caught by the next write or a persisted `pageshow` ownership check. A remote request already sent may complete. Confirmation/approval invalidation remains M4 work. Hosts must also clear their own non-galaxie storage and tokens. Logout supplies no authentication and keeps shared model assets; there is no local trace store to delete.

## Host-controlled retention and deletion

Nothing is swept automatically by the saver. After obtaining exclusive session ownership, the host can explicitly call:

```ts
const result = await saver.sweep();
// result: { prunedCheckpoints, expiredSessions }
await saver.deleteSession(sessionId); // Only when the host explicitly requests deletion.
```

`sweep({ historyMs?, expireMs?, now? })` defaults to 7 days of checkpoint history and 30 days of session inactivity. All supplied values must be finite, non-negative numbers; invalid options reject `invalid`. Each `put` records `savedAt`, and `put`, `putWrites` and recovery writes update the session's last activity in the same transaction. Activity is the latest write timestamp, even if the clock moves backward.

The sweep prunes checkpoints older than `historyMs`, always keeping the latest checkpoint in each namespace. Checkpoints without `savedAt` count as older than every cutoff. Associated pending writes are removed, except parent `TASKS` writes referenced by retained checkpoints: legacy pre-v4 tuples need them for identical reads. The sweep marks these preserved rows internally and reclaims them on later sweeps once no retained checkpoint needs them. Unmarked writes for checkpoints not yet stored remain untouched. Expired sessions lose their checkpoints, pending writes, inbox, journal and session metadata. `deleteSession` removes that same session data explicitly. Both operations stay within the saver's app/principal scope. Sweep deletion runs in one transaction per session; a rejected session transaction leaves that session untouched, while earlier completed sessions stay processed. Legacy sessions without activity metadata are not expired by an assumed age.

Hold app ownership while sweeping or deleting sessions; transaction-local fencing rejects a former owner. Host-local opens the saver without sweeping, acquires app-wide core ownership, then sweeps with defaults before restore. A sweep failure is observed without retrying in that page, and restore proceeds. Quota observations show "Storage is full"; handover shows "Reload to use the updated app" and disables input. An unrecoverable restore keeps the session and shows "Saved lesson cannot be recovered" with "Start over". Only that button deletes the session, under the same Web Lock, then clears the key. An unsupported agent version clears only the key and returns to Start; old data remains until a host sweep.

## Explicit session export

`saver.exportSession(sessionId, options?)` reads only the saver's app and principal.
Its deeply frozen, JSON-serializable `SessionExport` has format
`galaxie.session-export/1`, `appId`, `sessionId`, an ISO `exportedAt`,
`personalContent` and content-free `metadata`. The default omits `checkpoints`:

```ts
const metadataOnly = await saver.exportSession(instance.sessionId);
// Only from a host handler for an explicit user export action:
const personal = await saver.exportSession(instance.sessionId, { personalContent: true });
```

Hosts must bind `personalContent: true` to an explicit user action and treat the
result as personal data. Only the boolean `true` includes content. This method
does not download, transmit or persist the export. `examples/host-local` binds
it to two explicit actions, with personal content behind a host-rendered
confirmation; host-remote has no export. A package manifest never includes this session data.

Metadata contains the recorded agent identity (`null` for legacy checkpoints
without one), checkpoint count and first/last checkpoint timestamps (`null`
when absent), the count of distinct interrupt IDs in the latest checkpoint of
each namespace, and recovery submission/effect totals grouped by status.
The export does not include recovery inbox/journal records (submission payloads,
receipt outputs or input digests), even with the opt-in. Personal checkpoints
can contain the same learner text or capability results. No runtime-event
history is included.

The opt-in adds checkpoints ordered by ascending LangGraph checkpoint ID, then
namespace. Each has `id`, `parentId`, `namespace`, `timestamp`, decoded
`channelValues` and ordered `pendingWrites` tuples `[taskId, channel, value]`.
The saver's serde decodes values outside the read transaction. Binary values
become `{ type: 'base64', data }`; unrepresentable leaves, cycles and unreadable
values become the fixed string `[unavailable]`. Conversion copies enumerable
data properties without invoking getters or `toJSON`; errors are replaced,
not serialized. These conversions are lossy and supply no import/restore API.

Unreadable checkpoint or decoded-write data sets `metadata.unrecoverable: true`
on that export. The saver has no persisted session-unrecoverable marker;
export observes decoding failures without writing a marker or changing records.
Malformed stored record structures still reject with fixed `corrupt` errors.
Unknown or deleted sessions reject with existing `StorageError('invalid')`.
No error contains record content or sets `cause`.

Export reads remain available after app ownership loss. They check the held
principal logout generation in the read transaction and again after decoding,
so an invalidated saver cannot export a recreated principal's session or publish
content after logout during decoding. Already returned exports are host-owned
copies; logout cannot revoke them. App/principal keys do not isolate data from
other same-origin code. Keep credentials out of stored state. Database version,
record formats and storage schema remain unchanged.

## Write replay

The [core write journal](../../docs/system-design.md#83-a-capability-call) records `planned`, `dispatched`, `succeeded`, `failed` and `outcome_unknown`. Only `write` bindings use it. SHA-256 effect IDs derive from session, interaction (or literal `start`), capability name and per-name ordinal; input digests detect changed inputs/order. Keep call order deterministic and send `CapabilityContext.effectId` as the backend idempotency key. Replay returns fresh copies of already validated successful outputs without invoking or rerunning transforms, and reapplies their labels/private strings. Unknown writes replay only under `idempotent` or `idempotency-key`; `retry: 'none'` fails `outcome_unknown` and never invokes again. Aborting a request does not prove the backend did nothing. Journal writes are serialized; once a success write starts, abort cannot overwrite it. An ordinary store failure before invoke fails `unavailable`; after invoke an ordinary store failure preserves a validated result and reports `capability_failed` without result or raw store-error content. A fenced journal failure always fails the call with `fenced`, including after a validated result; an invalidated journal failure similarly fails with `stale`. Neither can publish a successful receipt after logout.

## Limits

There is no host reconciliation/decision API yet. An unknown `retry: 'none'` write keeps failing at the same call on restore. Reconcile with the backend using the effect ID from the binding or content-free `effect_outcome_unknown` diagnostic before creating a new session that might repeat the logical operation. New sessions derive new IDs, so galaxie cannot prevent that repeat. Repeated start segments within one session reuse literal `start` IDs; use a fresh session/instance for a new logical operation.

Drafts are not persisted. If a multi-step resume crashes after an intermediate checkpoint has resolved the interrupt, restore consumes the entry and returns `undefined`; it cannot finish that run or replay later writes. `deleteThread` keeps its `BaseCheckpointSaver` behavior: it deletes only that app's and principal's checkpoints, pending writes and insertion-order records, leaving recovery records and activity metadata. It is not a session or logout deletion API.

Persistence is not permanence: browsers can evict or clear storage, and quotas apply. Eviction looks like a fresh start: host-local clears the stored key when session metadata or pending state is absent. For durable or multi-device records, use the host backend or a consented export ([brief §12.4](../../docs/galaxie-project-brief.md#124-storage-limits)). Keep credentials out of graph state and checkpoints. Stored values may include private learner text and answer keys; keep storage on-device and scoped to the authenticated principal and session. This package does not encrypt data or isolate it from other same-origin code.

## Verification

Pure envelope/key/argument tests run on Node and Chromium. Real IndexedDB differential tests in Chromium compare scripted operations against the pinned `MemorySaver`, including ordering, filters, pending writes, special channels, namespaces and deletion. Recovery tests add atomic duplicates, completion barriers, aborted transactions, scope isolation, corrupt envelopes, session identity and inbox/journal reopen. Fencing tests reject every stale write path without record changes, cover cross-principal and concurrent claims, and preserve the epoch through sweep/deletion. Invalidation tests cover all stale write paths, non-owner logout, principal isolation, fresh savers and unchanged schema/epoch records. Chromium AT-13 exercises a paused graph, rejected late writes, empty principal stores after disposal and missed-notice bfcache detection. Host-local adds two-page sign-out, fresh reload, former-owner logout, failed-wipe rollback without peer notification and pre-preparation logout. Chromium AT-18 exercises cooperative handover, forced mid-run takeover, remote-effect deduplication and bfcache verification. Lifecycle tests cover retention, rollback, blocked/superseded upgrades, newer schemas, corruption, quota, eviction and incompatible agent versions. A real-adapter marked checkpoint failure maps to `unrecoverable` on Node and Chromium. A conformance type test checks structural assignability to core's port. The Chromium conformance lane retains all twelve M1 cases with unchanged goldens and matrix differences. Separate fault-injection graphs test inbox crash windows and write retry policies under `async`, `sync` and `exit` on Node and Chromium, including IndexedDB reopen in Chromium. The existing host-local loop still reloads at Quiz and WritingPrompt and completes unchanged. Tests use mock models only; no model weights, real WebLLM bundle or real model APIs are used.
