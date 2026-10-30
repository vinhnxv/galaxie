// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { afterEach, describe, expect, test } from 'vitest';
import { IndexedDBSaver } from '../src/index.js';
import { openDatabase, requestResult, transact } from '../src/schema.js';

const savers: IndexedDBSaver[] = [];
const databases: string[] = [];
async function open(
  name: string,
  principalScope = 'user',
  appId = 'app',
  onError?: (code: string) => void,
): Promise<IndexedDBSaver> {
  const saver = await IndexedDBSaver.open({
    databaseName: name,
    appId,
    principalScope,
    ...(onError ? { onError } : {}),
  });
  savers.push(saver);
  return saver;
}
const config = { configurable: { thread_id: 'session', checkpoint_ns: '', checkpoint_id: '001' } };
const answer = { interactionId: 'question', action: 'submit', payload: 'private answer' };
const effect = { status: 'dispatched', inputDigest: 'a'.repeat(64) } as const;
const identity = { agentId: 'tests/fencing', executorId: 'langgraph-js', agentVersion: '1' };
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
async function contents(name: string): Promise<unknown> {
  const db = await openDatabase(name, 'app', 'user');
  try {
    const stores = ['checkpoints', 'writes', 'meta', 'inbox', 'journal'];
    return await transact(db, stores, 'readonly', async (tx) =>
      Promise.all(
        stores.map(async (name) => ({
          name,
          keys: await requestResult(tx.objectStore(name).getAllKeys()),
          values: await requestResult(tx.objectStore(name).getAll()),
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
describe.skipIf(typeof indexedDB === 'undefined')('app-wide storage fencing', () => {
  test('fences every old write transaction without changing records, while reads and the new owner work', async () => {
    const name = `fencing-${crypto.randomUUID()}`;
    databases.push(name);
    const errors: string[] = [];
    const a = await open(name, 'user', 'app', (code) => errors.push(code));
    const b = await open(name);
    await seed(a);
    expect(await a.fencing.current()).toBe(true);
    await b.fencing.claim();
    expect(await a.fencing.current()).toBe(false);
    expect(await b.fencing.current()).toBe(true);
    const before = await contents(name);
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
      () => a.recovery.acceptSubmission('session', { ...answer, interactionId: 'late' }),
      () => a.recovery.consumeSubmission('session', 'question'),
      () =>
        a.recovery.recordEffect('session', 'effect', {
          ...effect,
          status: 'succeeded',
          output: 'late',
        }),
      () => a.sweep({ now: Date.now() + 100 * 86_400_000 }),
      () => a.deleteSession('session'),
    ];
    for (const write of writes) {
      await expect(write()).rejects.toMatchObject({
        code: 'fenced',
        message: 'Another tab took over the storage.',
        fenced: true,
        unrecoverable: false,
      });
      expect(await contents(name)).toEqual(before);
    }
    expect(errors).toEqual(writes.map(() => 'fenced'));
    expect(await a.getTuple(config)).toBeDefined();
    expect(await a.recovery.submissions('session')).toEqual([{ ...answer, status: 'accepted' }]);
    expect(await a.recovery.effect('session', 'effect')).toEqual(effect);
    await b.recovery.consumeSubmission('session', 'question');
    const reopened = await open(name);
    await reopened.recovery.recordSession('new', identity);
    expect(await reopened.fencing.current()).toBe(true);
  });
  test('serializes claims across principals, isolates apps, and preserves the app epoch through deletion and sweep', async () => {
    const name = `fencing-${crypto.randomUUID()}`;
    databases.push(name);
    const a = await open(name);
    const b = await open(name, 'other');
    const c = await open(name, 'user', 'other-app');
    await seed(a);
    await Promise.all([a.fencing.claim(), b.fencing.claim()]);
    expect([await a.fencing.current(), await b.fencing.current()].filter(Boolean)).toHaveLength(1);
    expect(await c.fencing.current()).toBe(true);
    const owner = await open(name);
    const listed: string[] = [];
    for await (const tuple of owner.list({})) listed.push(tuple.checkpoint.id);
    expect(listed).toEqual(['001']);
    await owner.deleteSession('session');
    await owner.sweep();
    const db = await openDatabase(name, 'app', 'user');
    try {
      expect(
        await transact(db, ['meta'], 'readonly', (tx) =>
          requestResult(tx.objectStore('meta').get(['app'])),
        ),
      ).toEqual({ v: 1, epoch: 2 });
    } finally {
      db.close();
    }
    expect(await owner.fencing.current()).toBe(true);
    await expect(a.recovery.recordSession('new', identity)).rejects.toMatchObject({
      code: 'fenced',
    });
  });
});
