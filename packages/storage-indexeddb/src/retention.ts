// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { TASKS } from '@langchain/langgraph-checkpoint';
import { StorageError } from './errors.js';
import type { Fencing } from './fencing.js';
import { prefixRange, validateKey } from './keys.js';
import { requestResult, transact } from './schema.js';

/** Internal clock seam; deliberately absent from the package root. */
export const storageClock: { now(): number } = { now: () => Date.now() };

export interface SweepOptions {
  readonly historyMs?: number;
  readonly expireMs?: number;
  readonly now?: number;
}
export interface SweepResult {
  readonly prunedCheckpoints: number;
  readonly expiredSessions: number;
}

const stores = ['checkpoints', 'writes', 'inbox', 'journal', 'meta'];
const day = 86_400_000;

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function activity(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('v' in value) ||
    value.v !== 1 ||
    !('lastActivity' in value) ||
    !timestamp(value.lastActivity)
  )
    throw new StorageError('corrupt');
  return value.lastActivity;
}

export async function touchSession(
  tx: IDBTransaction,
  scope: readonly [string, string],
  sessionId: string,
  now: number = storageClock.now(),
): Promise<void> {
  if (!timestamp(now)) throw new StorageError('unavailable');
  const meta = tx.objectStore('meta');
  const key = [...scope, 'activity', sessionId];
  const previous = activity(await requestResult(meta.get(key)));
  await requestResult(meta.put({ v: 1, lastActivity: Math.max(previous ?? now, now) }, key));
}

export async function deleteSessionRecords(
  tx: IDBTransaction,
  scope: readonly [string, string],
  sessionId: string,
): Promise<void> {
  const range = prefixRange([...scope, sessionId]);
  for (const name of ['checkpoints', 'writes', 'inbox', 'journal'])
    await requestResult(tx.objectStore(name).delete(range));
  const meta = tx.objectStore('meta');
  for (const kind of ['thread', 'activity', 'session'])
    await requestResult(meta.delete([...scope, kind, sessionId]));
  await requestResult(meta.delete(prefixRange([...scope, 'namespace', sessionId])));
}

async function sessions(db: IDBDatabase, scope: readonly [string, string]): Promise<string[]> {
  return transact(db, stores, 'readonly', async (tx) => {
    const found = new Set<string>();
    for (const name of stores) {
      const store = tx.objectStore(name);
      const request = store.openKeyCursor(prefixRange([...scope]));
      let cursor = await requestResult(request);
      while (cursor !== null) {
        const key = cursor.primaryKey;
        if (!Array.isArray(key)) throw new StorageError('corrupt');
        const session =
          name === 'meta'
            ? ['thread', 'namespace', 'activity', 'session'].includes(String(key[2]))
              ? key[3]
              : undefined
            : key[2];
        if (session !== undefined) {
          if (typeof session !== 'string' || session.length === 0)
            throw new StorageError('corrupt');
          found.add(session);
        }
        // Data stores are grouped by thread; skip the remaining records of that thread.
        if (name !== 'meta' && session !== undefined) cursor.continue([...scope, session, []]);
        else cursor.continue();
        cursor = await requestResult(request);
      }
    }
    return [...found].sort();
  });
}

interface HistoryRecord {
  readonly key: [string, string, string, string, string];
  readonly parentId: string | null;
  readonly savedAt?: number;
}
function history(
  value: unknown,
  scope: readonly [string, string],
  sessionId: string,
): HistoryRecord {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('v' in value) ||
    value.v !== 1 ||
    !('key' in value) ||
    !Array.isArray(value.key) ||
    value.key.length !== 5 ||
    !value.key.every((part) => typeof part === 'string') ||
    value.key[0] !== scope[0] ||
    value.key[1] !== scope[1] ||
    value.key[2] !== sessionId ||
    !('parentId' in value) ||
    !(value.parentId === null || typeof value.parentId === 'string') ||
    ('savedAt' in value && !timestamp(value.savedAt))
  )
    throw new StorageError('corrupt');
  return value as HistoryRecord;
}

export async function sweep(
  db: IDBDatabase,
  scope: readonly [string, string],
  fencing: Fencing,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const historyMs = options.historyMs ?? 7 * day;
  const expireMs = options.expireMs ?? 30 * day;
  const now = options.now ?? storageClock.now();
  if (![historyMs, expireMs, now].every(timestamp)) throw new StorageError('invalid');
  await fencing.write([], async () => {});
  let prunedCheckpoints = 0;
  let expiredSessions = 0;
  for (const sessionId of await sessions(db, scope)) {
    validateKey(sessionId);
    const result = await fencing.write(stores, async (tx) => {
      const lastActivity = activity(
        await requestResult(tx.objectStore('meta').get([...scope, 'activity', sessionId])),
      );
      if (lastActivity !== undefined && lastActivity < now - expireMs) {
        await deleteSessionRecords(tx, scope, sessionId);
        return { prunedCheckpoints: 0, expiredSessions: 1 };
      }
      const checkpoints = tx.objectStore('checkpoints');
      const raw: unknown[] = await requestResult(
        checkpoints.getAll(prefixRange([...scope, sessionId])),
      );
      const rows = raw.map((row) => history(row, scope, sessionId));
      const latest = new Map<string, string>();
      for (const row of rows)
        if ((latest.get(row.key[3]) ?? '') < row.key[4]) latest.set(row.key[3], row.key[4]);
      const removed = rows.filter(
        (row) =>
          row.key[4] !== latest.get(row.key[3]) &&
          (row.savedAt === undefined || row.savedAt < now - historyMs),
      );
      const removedSet = new Set(removed);
      const retained = rows.filter((row) => !removedSet.has(row));
      const parentTasks = new Set(
        retained
          .filter((row) => row.parentId !== null)
          .map((row) => JSON.stringify([...row.key.slice(0, 4), row.parentId])),
      );
      const retainedKeys = new Set(retained.map((row) => JSON.stringify(row.key)));
      const writes = tx.objectStore('writes');
      for (const row of removed) {
        await requestResult(checkpoints.delete(row.key));
        const range = prefixRange(row.key);
        if (!parentTasks.has(JSON.stringify(row.key))) {
          await requestResult(writes.delete(range));
          continue;
        }
        // Pre-v4 tuples reconstruct TASKS from parent writes. The version is serialized;
        // preserve these dependencies conservatively without awaiting a serializer in a transaction.
        const request = writes.openCursor(range);
        let cursor = await requestResult(request);
        while (cursor !== null) {
          const value: unknown = cursor.value;
          if (
            typeof value !== 'object' ||
            value === null ||
            !('channel' in value) ||
            typeof value.channel !== 'string'
          )
            throw new StorageError('corrupt');
          if (value.channel === TASKS)
            await requestResult(cursor.update({ ...value, retainedForHistory: true }));
          else await requestResult(cursor.delete());
          cursor.continue();
          cursor = await requestResult(request);
        }
      }
      // Native writes can precede checkpoints. Reclaim only dependencies a sweep retained.
      const request = writes.openCursor(prefixRange([...scope, sessionId]));
      let cursor = await requestResult(request);
      while (cursor !== null) {
        const value: unknown = cursor.value;
        if (
          typeof value === 'object' &&
          value !== null &&
          'retainedForHistory' in value &&
          value.retainedForHistory === true
        ) {
          const key = cursor.primaryKey;
          if (
            !Array.isArray(key) ||
            key.length !== 7 ||
            !key.slice(0, 6).every((part) => typeof part === 'string') ||
            !Number.isSafeInteger(key[6]) ||
            !('v' in value) ||
            value.v !== 1 ||
            !('channel' in value) ||
            value.channel !== TASKS
          )
            throw new StorageError('corrupt');
          const checkpoint = JSON.stringify(key.slice(0, 5));
          if (!retainedKeys.has(checkpoint) && !parentTasks.has(checkpoint))
            await requestResult(cursor.delete());
        }
        cursor.continue();
        cursor = await requestResult(request);
      }
      return { prunedCheckpoints: removed.length, expiredSessions: 0 };
    });
    prunedCheckpoints += result.prunedCheckpoints;
    expiredSessions += result.expiredSessions;
  }
  return { prunedCheckpoints, expiredSessions };
}
