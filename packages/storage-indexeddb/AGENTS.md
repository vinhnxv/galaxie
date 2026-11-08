# @galaxie-ai/storage-indexeddb: coding guidance

## Purpose

Persist LangGraph checkpoints and pending writes on-device, with a durable
submission inbox, effect journal and agent identity on the same scoped connection.
See the [README](README.md) and [recovery flow](../../docs/system-design.md#82-reload-and-crash-recovery).

## Entry points

- `@galaxie-ai/storage-indexeddb` exports `IndexedDBSaver`, `IndexedDBSaverOptions`,
  `StorageError`, `StorageErrorCode`, `IndexedDBRecovery`, `SessionExport` and
  `SessionExportValue`.
- The supported surface is [src/index.ts](src/index.ts); there are no subpaths.
- `IndexedDBSaver.open` constructs the saver; `saver.recovery` supplies core's
  recovery port structurally without importing core.

## Do

Derive the principal in trusted host code before opening storage:

```ts
import { IndexedDBSaver } from '@galaxie-ai/storage-indexeddb';

const saver = await IndexedDBSaver.open({
  appId: 'lesson-app', principalScope: 'demo-learner',
});
```

The literal principal is for a local example; an authenticated host derives it
from its own verified session.

- Supply both `services.checkpointer: saver` and `recovery: saver.recovery`.
- Custom recovery stores must round-trip `formatVersion` unchanged; never offer Start over for `newer_record`.
- Acquire app ownership with `fence: saver.fencing` before state writes or sweeps.
- Dispose the runtime before releasing ownership and closing the saver.
- Await `invalidatePrincipal()` before broadcasting logout; reopen afterward.
- Use `deleteSession` to remove the inbox/journal as well as checkpoints.
- Use `exportSession(sessionId)` for content-free metadata. Bind
  `personalContent: true` only to an explicit user export action and treat the
  result as personal data; see [export semantics](README.md#explicit-session-export).

## Never

- Never treat app/principal keys as authorization against other same-origin code.
- Never store credentials in checkpoints or send private checkpoint content off-device.
- Never bypass the generation/epoch checks inside each state-write transaction.
- Never mistake `deleteThread` for full session deletion or `persist()` for permanence.
- Never automatically repeat an unknown `retry: 'none'` write.

## Limits

Browser eviction may return a fresh start. Storage is not encrypted by this
package. Reload recovery needs compatible graph identity and an outstanding
interrupt; it cannot finish arbitrary intermediate checkpoints.
Exports are lossy JSON snapshots, with no import, sync or cross-device recovery.
Only `examples/host-local` wires an export UI. Logout rejects an in-progress export before
publication but cannot revoke copies already returned to host code.
Ownership must be composed by the host; an already-sent remote effect may finish.
See [ownership](../../docs/system-design.md#85-tab-ownership-and-takeover) and
[logout limits](../../docs/system-design.md#86-logout).

## Tests

Run `pnpm exec vitest run --project browser packages/storage-indexeddb/test` for
the [IndexedDB tests](test/), and `pnpm test tests/conformance/recovery.test.ts tests/conformance/restore.test.ts`
for recovery integration on the configured Node/Chromium lanes.
Tests use mock providers; run `pnpm check` before completion.
