// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { IndexedDBSaver, StorageError } from '../src/index.js';
import { openDatabase, requestResult, transact } from '../src/schema.js';

const names: string[] = [];
const connections: { close(): void }[] = [];
function name(): string {
  const value = `galaxie-lifecycle-${crypto.randomUUID()}`;
  names.push(value);
  return value;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const connection of connections.splice(0)) connection.close();
  for (const value of names.splice(0)) await requestResult(indexedDB.deleteDatabase(value));
});

describe.skipIf(typeof indexedDB === 'undefined')('storage lifecycle', () => {
  test('hands an upgrade to the newer opener and refuses every old operation', async () => {
    const databaseName = name();
    const onVersionChange = vi.fn();
    const onError = vi.fn();
    const saver = await IndexedDBSaver.open({
      databaseName,
      appId: 'app',
      principalScope: 'user',
      onVersionChange,
      onError,
    });
    connections.push(saver);
    const newer = await openDatabase(databaseName, 'app', 'other', 2);
    connections.push(newer);
    expect(onVersionChange).toHaveBeenCalledExactlyOnceWith();
    const config = {
      configurable: { thread_id: 'session', checkpoint_ns: '', checkpoint_id: '001' },
    };
    for (const operation of [
      () => saver.getTuple({}),
      () => saver.list({}).next(),
      () => saver.put(config, emptyCheckpoint(), { source: 'input', step: 0, parents: {} }, {}),
      () => saver.putWrites(config, [], 'task'),
      () => saver.deleteThread('session'),
      () => saver.recovery.submissions('session'),
      () =>
        saver.recovery.acceptSubmission('session', {
          interactionId: 'question',
          action: 'submit',
          payload: false,
        }),
      () => saver.recovery.consumeSubmission('session', 'question'),
      () => saver.recovery.effect('session', 'effect'),
      () =>
        saver.recovery.recordEffect('session', 'effect', {
          status: 'planned',
          inputDigest: 'a'.repeat(64),
        }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: 'superseded', unrecoverable: true });
      expect(onError.mock.lastCall).toEqual(['superseded']);
    }
    expect(onError).toHaveBeenCalledTimes(10);
    saver.close();
    expect(onVersionChange).toHaveBeenCalledTimes(1);
  });

  test('observes request quota failures once without host text or partial checkpoints', async () => {
    const databaseName = name();
    const onError = vi.fn(() => {
      throw new Error('private observer text');
    });
    const saver = await IndexedDBSaver.open({
      databaseName,
      appId: 'app',
      principalScope: 'user',
      onError,
    });
    connections.push(saver);
    const native = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      if (this.name !== 'checkpoints') return native.apply(this, args);
      const request = native.apply(this, args);
      request.addEventListener('success', () => {
        Object.defineProperty(request, 'error', {
          value: new DOMException('private quota text', 'QuotaExceededError'),
        });
        request.onerror?.(new Event('error'));
        this.transaction.abort();
      });
      return request;
    });
    await expect(
      saver.put(
        { configurable: { thread_id: 'session' } },
        emptyCheckpoint(),
        { source: 'input', step: 0, parents: {} },
        {},
      ),
    ).rejects.toEqual(new StorageError('quota'));
    expect(onError).toHaveBeenCalledExactlyOnceWith('quota');
    expect(await saver.getTuple({ configurable: { thread_id: 'session' } })).toBeUndefined();
  });

  test('observes corrupt records and marks only unrecoverable codes', async () => {
    const databaseName = name();
    const onError = vi.fn();
    const saver = await IndexedDBSaver.open({
      databaseName,
      appId: 'app',
      principalScope: 'user',
      onError,
    });
    connections.push(saver);
    const db = await openDatabase(databaseName, 'app', 'user');
    connections.push(db);
    await transact(db, ['checkpoints'], 'readwrite', async (tx) => {
      await requestResult(
        tx.objectStore('checkpoints').put({ key: ['app', 'user', 'session', '', '001'], v: 99 }),
      );
    });
    await expect(saver.getTuple({ configurable: { thread_id: 'session' } })).rejects.toMatchObject({
      code: 'corrupt',
      unrecoverable: true,
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith('corrupt');
    for (const code of [
      'corrupt',
      'newer_schema',
      'superseded',
      'invalid',
      'quota',
      'blocked',
      'aborted',
      'unavailable',
    ] as const) {
      const error = new StorageError(code);
      expect(Object.getOwnPropertyDescriptor(error, 'unrecoverable')).toMatchObject({
        value: ['corrupt', 'newer_schema', 'superseded'].includes(code),
        writable: false,
      });
      expect(error).not.toHaveProperty('cause');
    }
  });

  test('observes a newer schema refusal while keeping scoped schema validation', async () => {
    const databaseName = name();
    const db = await openDatabase(databaseName, 'app', 'user');
    db.close();
    await expect(openDatabase(databaseName, 'app', 'user', 2)).rejects.toMatchObject({
      code: 'corrupt',
    });
    const onError = vi.fn();
    await expect(
      IndexedDBSaver.open({ databaseName, appId: 'app', principalScope: 'user', onError }),
    ).rejects.toMatchObject({ code: 'newer_schema', unrecoverable: true });
    expect(onError).toHaveBeenCalledExactlyOnceWith('newer_schema');
  });

  test('swallows a version-change observer failure and still closes', async () => {
    const databaseName = name();
    const saver = await IndexedDBSaver.open({
      databaseName,
      appId: 'app',
      principalScope: 'user',
      onVersionChange: () => {
        throw new Error('private text');
      },
    });
    connections.push(saver);
    const newer = await openDatabase(databaseName, 'app', 'other', 2);
    connections.push(newer);
    await expect(saver.getTuple({})).rejects.toMatchObject({ code: 'superseded' });
  });
});
