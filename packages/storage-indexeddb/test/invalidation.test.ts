// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { afterEach, describe, expect, test } from 'vitest';
import { IndexedDBSaver } from '../src/index.js';
import { prefixRange } from '../src/keys.js';
import { openDatabase, requestResult, transact } from '../src/schema.js';

const savers: IndexedDBSaver[] = [];
const databases: string[] = [];
const config = { configurable: { thread_id: 'session', checkpoint_ns: '', checkpoint_id: '001' } };
const identity = { agentId: 'tests/invalidation', agentVersion: '1' };
const answer = { interactionId: 'question', action: 'submit', payload: 'private answer' };
const effect = { status: 'dispatched', inputDigest: 'a'.repeat(64) } as const;

async function open(
  name: string,
  principalScope = 'user',
  errors?: string[],
): Promise<IndexedDBSaver> {
  const saver = await IndexedDBSaver.open({
    appId: 'app',
    principalScope,
    databaseName: name,
    ...(errors ? { onError: (code) => errors.push(code) } : {}),
  });
  savers.push(saver);
  return saver;
}
async function seed(saver: IndexedDBSaver): Promise<void> {
  await saver.put(
    config,
    { ...emptyCheckpoint(), id: '001' },
    { source: 'input', step: 0, parents: {} },
    {},
  );
  await saver.putWrites(config, [['value', 'initial']], 'task');
  await saver.recovery.recordSession('session', identity);
  await saver.recovery.acceptSubmission('session', answer);
  await saver.recovery.recordEffect('session', 'effect', effect);
}
async function contents(name: string, principal = 'user'): Promise<unknown[]> {
  const db = await openDatabase(name, 'app', principal);
  try {
    const stores = ['checkpoints', 'writes', 'inbox', 'journal', 'meta'];
    return await transact(db, stores, 'readonly', (tx) =>
      Promise.all(
        stores.map(async (name) => ({
          name,
          keys: await requestResult(
            tx.objectStore(name).getAllKeys(prefixRange(['app', principal])),
          ),
          values: await requestResult(tx.objectStore(name).getAll(prefixRange(['app', principal]))),
        })),
      ),
    );
  } finally {
    db.close();
  }
}
afterEach(async () => {
  for (const saver of savers.splice(0)) saver.close();
  for (const name of databases.splice(0)) await requestResult(indexedDB.deleteDatabase(name));
});

describe.skipIf(typeof indexedDB === 'undefined')('principal invalidation', () => {
  test('atomically wipes one principal and rejects every old write, including claims', async () => {
    const name = `invalidation-${crypto.randomUUID()}`;
    databases.push(name);
    const errors: string[] = [];
    const a = await open(name, 'user', errors);
    const b = await open(name);
    const other = await open(name, 'other');
    await seed(a);
    await seed(other);
    const otherBefore = await contents(name, 'other');
    // B never claims: logout remains available after the app epoch changed.
    await a.fencing.claim();
    await b.invalidatePrincipal();
    expect(await a.fencing.current()).toBe(false);
    expect(await b.fencing.current()).toBe(false);
    const wiped = [
      ...['checkpoints', 'writes', 'inbox', 'journal'].map((name) => ({
        name,
        keys: [],
        values: [],
      })),
      {
        name: 'meta',
        keys: [
          ['app', 'user', 'generation'],
          ['app', 'user', 'schema'],
        ],
        values: [
          { v: 1, generation: 1 },
          { v: 1, schemaVersion: 1 },
        ],
      },
    ];
    expect(await contents(name)).toEqual(wiped);
    const writes = [
      () =>
        a.put(
          config,
          { ...emptyCheckpoint(), id: '002' },
          { source: 'loop', step: 1, parents: {} },
          {},
        ),
      () => a.putWrites(config, [['value', 'late']], 'late-task'),
      () => a.deleteThread('session'),
      () => a.recovery.recordSession('late', identity),
      () => a.recovery.acceptSubmission('session', answer),
      () => a.recovery.consumeSubmission('session', 'question'),
      () =>
        a.recovery.recordEffect('session', 'effect', {
          ...effect,
          status: 'succeeded',
          output: 'late',
        }),
      () => a.sweep(),
      () => a.deleteSession('session'),
      () => a.fencing.claim(),
    ];
    for (const write of writes) {
      await expect(write()).rejects.toMatchObject({
        code: 'invalidated',
        message: "The principal's storage was invalidated.",
        invalidated: true,
        fenced: false,
        unrecoverable: false,
      });
      expect(await contents(name)).toEqual(wiped);
    }
    expect(errors).toEqual(writes.map(() => 'invalidated'));
    // Both generation and epoch differ on B; invalidation wins.
    await expect(b.recovery.recordSession('late', identity)).rejects.toMatchObject({
      code: 'invalidated',
    });
    expect(await contents(name, 'other')).toEqual(otherBefore);
    const db = await openDatabase(name, 'app', 'user');
    try {
      expect(
        await transact(db, ['meta'], 'readonly', (tx) =>
          requestResult(tx.objectStore('meta').get(['app'])),
        ),
      ).toEqual({ v: 1, epoch: 1 });
    } finally {
      db.close();
    }
    const fresh = await open(name);
    await fresh.sweep();
    expect(await contents(name)).toEqual(wiped);
    await seed(fresh);
    expect(await fresh.getTuple(config)).toBeDefined();
    expect(await fresh.fencing.current()).toBe(true);
  });
});
