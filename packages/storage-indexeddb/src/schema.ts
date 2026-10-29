// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { StorageError, type StorageErrorCode, storageError } from './errors.js';

interface ConnectionState {
  superseded: boolean;
  readonly onError?: ((code: StorageErrorCode) => void) | undefined;
}
const connections = new WeakMap<IDBDatabase, ConnectionState>();

export function observeError(
  onError: ((code: StorageErrorCode) => void) | undefined,
  error: unknown,
): StorageError {
  const fixed = storageError(error);
  try {
    void Promise.resolve(onError?.(fixed.code)).catch(() => {});
  } catch {}
  return fixed;
}

export function manageConnection(
  db: IDBDatabase,
  options: {
    readonly onError?: ((code: StorageErrorCode) => void) | undefined;
    readonly onVersionChange?: (() => void) | undefined;
  },
): void {
  const state: ConnectionState = { superseded: false, onError: options.onError };
  connections.set(db, state);
  db.addEventListener('versionchange', () => {
    db.close();
    if (state.superseded) return;
    state.superseded = true;
    try {
      void Promise.resolve(options.onVersionChange?.()).catch(() => {});
    } catch {}
  });
}

export function assertConnection(db: IDBDatabase): void {
  if (connections.get(db)?.superseded) throw new StorageError('superseded');
}

export function operationError(db: IDBDatabase, error: unknown): StorageError {
  return observeError(connections.get(db)?.onError, error);
}

export async function storageOperation<T>(db: IDBDatabase, work: () => Promise<T>): Promise<T> {
  try {
    assertConnection(db);
    return await work();
  } catch (error) {
    throw operationError(db, error);
  }
}

export const SCHEMA_VERSION: number = 1;

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(storageError(request.error));
  });
}

/** Work may await IndexedDB requests only; serialize before opening the transaction. */
export function transact<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      assertConnection(db);
      try {
        tx = db.transaction(stores, mode, { durability: 'strict' });
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        tx = db.transaction(stores, mode);
      }
    } catch (error) {
      reject(storageError(error));
      return;
    }
    let result: T;
    let failure: StorageError | undefined;
    tx.oncomplete = () => resolve(result);
    tx.onerror = (event) => {
      failure ??= storageError((event.target as IDBRequest<unknown>).error ?? tx.error);
    };
    tx.onabort = () =>
      reject(failure ?? storageError(tx.error ?? new DOMException('', 'AbortError')));
    void work(tx).then(
      (value) => {
        result = value;
      },
      (error: unknown) => {
        // An external abort can invalidate the transaction between awaited requests.
        failure =
          error instanceof DOMException && error.name === 'TransactionInactiveError'
            ? storageError(tx.error ?? new DOMException('', 'AbortError'))
            : storageError(error);
        try {
          tx.abort();
        } catch {
          reject(failure);
        }
      },
    );
  });
}

export async function openDatabase(
  name: string,
  appId: string,
  principalScope: string,
  version: number = SCHEMA_VERSION,
): Promise<IDBDatabase> {
  let db: IDBDatabase | undefined;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, version);
      let refused = false;
      request.onblocked = () => {
        refused = true;
        reject(new StorageError('blocked'));
      };
      request.onerror = () => reject(storageError(request.error));
      request.onupgradeneeded = (event) => {
        if (refused) {
          request.transaction?.abort();
          return;
        }
        const connection = request.result;
        if (event.oldVersion !== 0) return;
        const checkpoints = connection.createObjectStore('checkpoints', { keyPath: 'key' });
        checkpoints.createIndex('thread', 'thread');
        checkpoints.createIndex('namespace', 'namespace');
        const writes = connection.createObjectStore('writes', { keyPath: 'key' });
        writes.createIndex('thread', 'thread');
        writes.createIndex('checkpoint', 'checkpoint');
        connection.createObjectStore('meta');
        connection.createObjectStore('inbox');
        connection.createObjectStore('journal');
      };
      request.onsuccess = () => {
        if (refused) request.result.close();
        else resolve(request.result);
      };
    });
    await transact(db, ['meta'], 'readwrite', async (tx) => {
      const store = tx.objectStore('meta');
      const key = [appId, principalScope, 'schema'];
      const stored: unknown = await requestResult(store.get(key));
      if (stored === undefined) {
        await requestResult(store.put({ v: 1, schemaVersion: version }, key));
      } else if (
        typeof stored !== 'object' ||
        stored === null ||
        !('v' in stored) ||
        stored.v !== 1 ||
        !('schemaVersion' in stored) ||
        stored.schemaVersion !== version
      ) {
        throw new StorageError('corrupt');
      }
    });
    return db;
  } catch (error) {
    db?.close();
    throw storageError(error);
  }
}
