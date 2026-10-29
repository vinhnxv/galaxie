// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '../src/schema.js';

const databases: string[] = [];
const connections: IDBDatabase[] = [];

function databaseName(): string {
  const name = `galaxie-schema-${crypto.randomUUID()}`;
  databases.push(name);
  return name;
}

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  for (const name of databases.splice(0))
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Database cleanup was blocked.'));
    });
});

it('creates version one with all stores, indexes and scoped schema metadata', async () => {
  const db = await openDatabase(databaseName(), 'app', 'user');
  connections.push(db);
  expect(db.version).toBe(1);
  expect([...db.objectStoreNames]).toEqual(['checkpoints', 'inbox', 'journal', 'meta', 'writes']);
  const tx = db.transaction(['checkpoints', 'writes', 'meta']);
  expect([...tx.objectStore('checkpoints').indexNames]).toEqual(['namespace', 'thread']);
  expect([...tx.objectStore('writes').indexNames]).toEqual(['checkpoint', 'thread']);
  const record = await new Promise<unknown>((resolve, reject) => {
    const request = tx.objectStore('meta').get(['app', 'user', 'schema']);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  expect(record).toEqual({ v: 1, schemaVersion: 1 });
  db.close();
  db.close();
});

it('refuses a newer database schema', async () => {
  const name = databaseName();
  const db = await openDatabase(name, 'app', 'user', 2);
  db.close();
  await expect(openDatabase(name, 'app', 'user')).rejects.toMatchObject({
    code: 'newer_schema',
  });
});

it('rejects blocked upgrades immediately and cancels the late upgrade', async () => {
  const name = databaseName();
  const db = await openDatabase(name, 'app', 'user');
  connections.push(db);
  await expect(openDatabase(name, 'app', 'user', 2)).rejects.toMatchObject({ code: 'blocked' });
  db.close();
  // Queued after the rejected upgrade: it must still be version one.
  const reopened = await openDatabase(name, 'app', 'user');
  connections.push(reopened);
  expect(reopened.version).toBe(1);
});
