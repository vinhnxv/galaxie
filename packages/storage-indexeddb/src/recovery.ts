// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { StorageError } from './errors.js';
import type { Fencing } from './fencing.js';
import { prefixRange, validateKey } from './keys.js';
import { touchSession } from './retention.js';
import { requestResult, storageOperation, transact } from './schema.js';
import type { SessionExport } from './session-export.js';

export type RecoveryValue =
  | null
  | boolean
  | number
  | string
  | RecoveryValue[]
  | { [key: string]: RecoveryValue };

export interface StoredSession {
  readonly agentId: string;
  readonly agentVersion: string;
}

export interface StoredSubmission {
  readonly interactionId: string;
  readonly action: string;
  readonly payload: RecoveryValue;
  readonly status: 'accepted' | 'consumed';
}

export type StoredEffect =
  | {
      readonly status: 'planned' | 'dispatched' | 'failed' | 'outcome_unknown';
      readonly inputDigest: string;
    }
  | { readonly status: 'succeeded'; readonly inputDigest: string; readonly output: RecoveryValue };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJson(value: unknown, ancestors = new Set<object>()): value is RecoveryValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (
    typeof value !== 'object' ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) ||
    ancestors.has(value)
  )
    return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Array.from(value).every((item) => isJson(item, ancestors))
    : Reflect.ownKeys(value).every((key) => {
        const property = Object.getOwnPropertyDescriptor(value, key);
        return (
          typeof key === 'string' &&
          property?.enumerable === true &&
          'value' in property &&
          isJson(property.value, ancestors)
        );
      });
  ancestors.delete(value);
  return valid;
}

function copyJson(value: unknown): RecoveryValue {
  try {
    if (isJson(value)) return JSON.parse(JSON.stringify(value)) as RecoveryValue;
  } catch {
    // Validation failures carry no stored data or host error text.
  }
  throw new StorageError('corrupt');
}

function envelope(value: unknown): unknown {
  if (!object(value) || value['v'] !== 1 || Object.keys(value).length !== 2 || !('value' in value))
    throw new StorageError('corrupt');
  return value['value'];
}

function sessionRecord(value: unknown): StoredSession {
  const copy = copyJson(value);
  if (
    !object(copy) ||
    Object.keys(copy).length !== 2 ||
    typeof copy['agentId'] !== 'string' ||
    copy['agentId'].length === 0 ||
    typeof copy['agentVersion'] !== 'string' ||
    copy['agentVersion'].length === 0
  )
    throw new StorageError('corrupt');
  return copy as unknown as StoredSession;
}

function submission(value: unknown, interactionId: string): StoredSubmission {
  if (
    !object(value) ||
    Object.keys(value).length !== 4 ||
    value['interactionId'] !== interactionId ||
    typeof value['action'] !== 'string' ||
    value['action'].length === 0 ||
    !('payload' in value) ||
    (value['status'] !== 'accepted' && value['status'] !== 'consumed')
  )
    throw new StorageError('corrupt');
  return copyJson(value) as unknown as StoredSubmission;
}

function effect(value: unknown): StoredEffect {
  if (
    !object(value) ||
    typeof value['inputDigest'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value['inputDigest']) ||
    (value['status'] === 'succeeded'
      ? Object.keys(value).length !== 3 || !('output' in value)
      : Object.keys(value).length !== 2 ||
        !['planned', 'dispatched', 'failed', 'outcome_unknown'].includes(value['status'] as string))
  )
    throw new StorageError('corrupt');
  return copyJson(value) as unknown as StoredEffect;
}

/** Project only identity and status counts from one transaction's scoped records. */
export async function readSessionSummary(
  tx: IDBTransaction,
  scope: readonly [string, string],
  sessionId: string,
): Promise<Pick<SessionExport['metadata'], 'agent' | 'recovery'>> {
  const stored: unknown = await requestResult(
    tx.objectStore('meta').get([...scope, 'session', sessionId]),
  );
  const agent = stored === undefined ? null : Object.freeze(sessionRecord(envelope(stored)));
  const submissions = { count: 0, accepted: 0, consumed: 0 };
  const effects = {
    count: 0,
    planned: 0,
    dispatched: 0,
    succeeded: 0,
    failed: 0,
    outcome_unknown: 0,
  };
  const range = prefixRange([...scope, sessionId]);
  const inbox: unknown[] = await requestResult(tx.objectStore('inbox').getAll(range));
  for (const row of inbox) {
    const value = envelope(row);
    if (!object(value) || typeof value['interactionId'] !== 'string')
      throw new StorageError('corrupt');
    const entry = submission(value, value['interactionId']);
    submissions.count++;
    submissions[entry.status]++;
  }
  const journal: unknown[] = await requestResult(tx.objectStore('journal').getAll(range));
  for (const row of journal) {
    const entry = effect(envelope(row));
    effects.count++;
    effects[entry.status]++;
  }
  return {
    agent,
    recovery: Object.freeze({
      submissions: Object.freeze(submissions),
      effects: Object.freeze(effects),
    }),
  };
}

/** Durable JSON inbox and write receipts on the saver's principal-scoped connection. */
export class IndexedDBRecovery {
  readonly #db: IDBDatabase;
  readonly #fencing: Fencing;
  readonly #scope: readonly [string, string];

  constructor(db: IDBDatabase, scope: readonly [string, string], fencing: Fencing) {
    this.#db = db;
    this.#fencing = fencing;
    this.#scope = [...scope];
  }

  #key(sessionId: string, id: string): string[] {
    validateKey(sessionId);
    validateKey(id);
    return [...this.#scope, sessionId, id];
  }

  async recordSession(sessionId: string, record: StoredSession): Promise<StoredSession> {
    return storageOperation(this.#db, async () => {
      validateKey(sessionId);
      const saved = sessionRecord(record);
      return this.#fencing.write(['meta'], async (tx) => {
        const store = tx.objectStore('meta');
        const key = [...this.#scope, 'session', sessionId];
        const existing: unknown = await requestResult(store.get(key));
        const stored = existing === undefined ? saved : sessionRecord(envelope(existing));
        await touchSession(tx, this.#scope, sessionId);
        if (existing === undefined) await requestResult(store.put({ v: 1, value: saved }, key));
        return stored;
      });
    });
  }

  async session(sessionId: string): Promise<StoredSession | undefined> {
    return storageOperation(this.#db, async () => {
      validateKey(sessionId);
      return transact(this.#db, ['meta'], 'readonly', async (tx) => {
        const stored: unknown = await requestResult(
          tx.objectStore('meta').get([...this.#scope, 'session', sessionId]),
        );
        return stored === undefined ? undefined : sessionRecord(envelope(stored));
      });
    });
  }

  async acceptSubmission(
    sessionId: string,
    entry: Omit<StoredSubmission, 'status'>,
  ): Promise<'accepted' | 'duplicate'> {
    return storageOperation(this.#db, async () => {
      const key = this.#key(sessionId, entry.interactionId);
      const saved = submission({ ...entry, status: 'accepted' }, entry.interactionId);
      return this.#fencing.write(['inbox', 'meta'], async (tx) => {
        await touchSession(tx, this.#scope, sessionId);
        const store = tx.objectStore('inbox');
        const existing: unknown = await requestResult(store.get(key));
        if (existing !== undefined) {
          submission(envelope(existing), entry.interactionId);
          return 'duplicate';
        }
        await requestResult(store.put({ v: 1, value: saved }, key));
        return 'accepted';
      });
    });
  }

  async consumeSubmission(sessionId: string, interactionId: string): Promise<void> {
    return storageOperation(this.#db, async () => {
      const key = this.#key(sessionId, interactionId);
      await this.#fencing.write(['inbox', 'meta'], async (tx) => {
        await touchSession(tx, this.#scope, sessionId);
        const store = tx.objectStore('inbox');
        const existing: unknown = await requestResult(store.get(key));
        if (existing === undefined) return;
        const saved = submission(envelope(existing), interactionId);
        if (saved.status === 'consumed') return;
        await requestResult(store.put({ v: 1, value: { ...saved, status: 'consumed' } }, key));
      });
    });
  }

  async submissions(sessionId: string): Promise<StoredSubmission[]> {
    return storageOperation(this.#db, async () => {
      validateKey(sessionId);
      const prefix = [...this.#scope, sessionId];
      return transact(this.#db, ['inbox'], 'readonly', async (tx) => {
        const entries: StoredSubmission[] = [];
        const request = tx.objectStore('inbox').openCursor(prefixRange(prefix));
        let cursor = await requestResult(request);
        while (cursor !== null) {
          const key = cursor.primaryKey;
          if (
            !Array.isArray(key) ||
            key.length !== 4 ||
            !prefix.every((part, index) => key[index] === part) ||
            typeof key[3] !== 'string' ||
            key[3].length === 0
          )
            throw new StorageError('corrupt');
          entries.push(submission(envelope(cursor.value), key[3]));
          cursor.continue();
          cursor = await requestResult(request);
        }
        return entries;
      });
    });
  }

  async effect(sessionId: string, effectId: string): Promise<StoredEffect | undefined> {
    return storageOperation(this.#db, async () => {
      const key = this.#key(sessionId, effectId);
      return transact(this.#db, ['journal'], 'readonly', async (tx) => {
        const existing: unknown = await requestResult(tx.objectStore('journal').get(key));
        return existing === undefined ? undefined : effect(envelope(existing));
      });
    });
  }

  async recordEffect(sessionId: string, effectId: string, record: StoredEffect): Promise<void> {
    return storageOperation(this.#db, async () => {
      const key = this.#key(sessionId, effectId);
      const saved = effect(record);
      await this.#fencing.write(['journal', 'meta'], async (tx) => {
        await touchSession(tx, this.#scope, sessionId);
        const store = tx.objectStore('journal');
        const existing: unknown = await requestResult(store.get(key));
        if (existing !== undefined && effect(envelope(existing)).status === 'succeeded') return;
        await requestResult(store.put({ v: 1, value: saved }, key));
      });
    });
  }
}
