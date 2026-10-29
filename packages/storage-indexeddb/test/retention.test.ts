// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { RunnableConfig } from '@langchain/core/runnables';
import { emptyCheckpoint, TASKS } from '@langchain/langgraph-checkpoint';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { IndexedDBSaver, StorageError } from '../src/index.js';
import { storageClock } from '../src/retention.js';
import { openDatabase, requestResult, transact } from '../src/schema.js';

const databases: string[] = [];
const savers: IndexedDBSaver[] = [];
const day = 86_400_000;
const cfg = (thread = 'session', ns = '', id?: string): RunnableConfig => ({
  configurable: { thread_id: thread, checkpoint_ns: ns, ...(id ? { checkpoint_id: id } : {}) },
});
async function open(
  databaseName = `galaxie-retention-${crypto.randomUUID()}`,
  principalScope = 'user',
): Promise<IndexedDBSaver> {
  if (!databases.includes(databaseName)) databases.push(databaseName);
  const saver = await IndexedDBSaver.open({ databaseName, appId: 'app', principalScope });
  savers.push(saver);
  return saver;
}
async function save(
  saver: IndexedDBSaver,
  config: RunnableConfig,
  id: string,
  v = 4,
): Promise<RunnableConfig> {
  return saver.put(
    config,
    { ...emptyCheckpoint(), id, v, channel_values: { answer: id } },
    { source: 'loop', step: 1, parents: {} },
    {},
  );
}
async function list(saver: IndexedDBSaver, config: RunnableConfig = {}): Promise<unknown[]> {
  const entries = [];
  for await (const value of saver.list(config)) entries.push(value);
  return entries;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const saver of savers.splice(0)) saver.close();
  for (const name of databases.splice(0)) await requestResult(indexedDB.deleteDatabase(name));
});

describe.skipIf(typeof indexedDB === 'undefined')('retention', () => {
  test('prunes old history and its writes but preserves latest namespace tuples including legacy parent tasks', async () => {
    const saver = await open();
    const clock = vi.spyOn(storageClock, 'now').mockReturnValue(day);
    const first = await save(saver, cfg(), '001');
    await saver.putWrites(
      first,
      [
        ['answer', 'old write'],
        [TASKS, { task: 'parent' }],
      ],
      'task',
    );
    const latest = await save(saver, first, '003', 3);
    await saver.putWrites(latest, [['answer', 'latest write']], 'task');
    await save(saver, cfg('session', 'child'), '001');
    clock.mockReturnValue(9 * day);
    const fresh = await save(saver, cfg(), '002');
    const expected = await list(saver);
    const latestBefore = await saver.getTuple(latest);
    const freshBefore = await saver.getTuple(fresh);
    expect(await saver.sweep({ now: 10 * day })).toEqual({
      prunedCheckpoints: 1,
      expiredSessions: 0,
    });
    expect(await saver.getTuple(latest)).toEqual(latestBefore);
    expect(await saver.getTuple(fresh)).toEqual(freshBefore);
    expect(await list(saver)).toEqual(
      expected.filter(
        (tuple) =>
          (tuple as { checkpoint: { id: string }; config: RunnableConfig }).checkpoint.id !==
            '001' ||
          (tuple as { config: RunnableConfig }).config.configurable?.['checkpoint_ns'] === 'child',
      ),
    );
    expect(await saver.getTuple(first)).toBeUndefined();
  });

  test('expires whole sessions across all five stores while preserving fresh and other-principal sessions', async () => {
    const name = `galaxie-retention-scope-${crypto.randomUUID()}`;
    const saver = await open(name);
    const other = await open(name, 'other');
    const clock = vi.spyOn(storageClock, 'now').mockReturnValue(day);
    for (const target of [saver, other]) {
      const checkpoint = await save(target, cfg('expired'), '001');
      await target.putWrites(checkpoint, [['answer', 1]], 'task');
      await target.recovery.acceptSubmission('expired', {
        interactionId: 'question',
        action: 'submit',
        payload: false,
      });
      await target.recovery.recordEffect('expired', 'effect', {
        status: 'planned',
        inputDigest: 'a'.repeat(64),
      });
    }
    clock.mockReturnValue(40 * day);
    await save(saver, cfg('fresh'), '001');
    const otherBefore = await list(other);
    expect(await saver.sweep({ now: 40 * day })).toEqual({
      prunedCheckpoints: 0,
      expiredSessions: 1,
    });
    expect(await saver.getTuple(cfg('expired'))).toBeUndefined();
    expect(await saver.recovery.submissions('expired')).toEqual([]);
    expect(await saver.recovery.effect('expired', 'effect')).toBeUndefined();
    expect(await saver.getTuple(cfg('fresh'))).toBeDefined();
    expect(await list(other)).toEqual(otherBefore);
    const db = await openDatabase(name, 'app', 'user');
    try {
      const keys = await transact(db, ['meta'], 'readonly', (tx) =>
        requestResult(tx.objectStore('meta').getAllKeys()),
      );
      expect(
        keys.filter((key) => Array.isArray(key) && key[1] === 'user' && key.includes('expired')),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  test.each(['putWrites', 'accept', 'consume', 'effect'] as const)(
    'updates last activity on %s and prevents expiry',
    async (operation) => {
      const saver = await open();
      const clock = vi.spyOn(storageClock, 'now').mockReturnValue(day);
      const saved = await save(saver, cfg(), '001');
      await saver.recovery.acceptSubmission('session', {
        interactionId: 'question',
        action: 'submit',
        payload: false,
      });
      clock.mockReturnValue(40 * day);
      if (operation === 'putWrites') await saver.putWrites(saved, [['answer', 1]], 'task');
      if (operation === 'accept')
        await saver.recovery.acceptSubmission('session', {
          interactionId: 'second',
          action: 'submit',
          payload: false,
        });
      if (operation === 'consume') await saver.recovery.consumeSubmission('session', 'question');
      if (operation === 'effect')
        await saver.recovery.recordEffect('session', 'effect', {
          status: 'planned',
          inputDigest: 'a'.repeat(64),
        });
      expect(await saver.sweep({ now: 40 * day })).toEqual({
        prunedCheckpoints: 0,
        expiredSessions: 0,
      });
      expect(await saver.getTuple(cfg())).toBeDefined();
    },
  );

  test('deletes only the explicitly named session, including recovery-only sessions', async () => {
    const saver = await open();
    await save(saver, cfg(), '001');
    await save(saver, cfg('keep'), '001');
    await saver.recovery.acceptSubmission('session', {
      interactionId: 'question',
      action: 'submit',
      payload: false,
    });
    await saver.recovery.recordEffect('session', 'effect', {
      status: 'planned',
      inputDigest: 'a'.repeat(64),
    });
    await saver.deleteSession('session');
    expect(await saver.getTuple(cfg())).toBeUndefined();
    expect(await saver.recovery.submissions('session')).toEqual([]);
    expect(await saver.recovery.effect('session', 'effect')).toBeUndefined();
    expect(await saver.getTuple(cfg('keep'))).toBeDefined();
    await saver.recovery.recordEffect('orphan', 'effect', {
      status: 'planned',
      inputDigest: 'a'.repeat(64),
    });
    await saver.deleteSession('orphan');
    expect(await saver.recovery.effect('orphan', 'effect')).toBeUndefined();
    await saver.deleteSession('missing');
  });

  test.each([
    { historyMs: -1 },
    { expireMs: Infinity },
    { now: NaN },
    { historyMs: NaN },
    { expireMs: -1 },
    { now: -1 },
  ])('rejects invalid options without deletion: %j', async (options) => {
    const saver = await open();
    await save(saver, cfg(), '001');
    const before = await list(saver);
    await expect(saver.sweep(options)).rejects.toEqual(new StorageError('invalid'));
    expect(await list(saver)).toEqual(before);
  });

  test('rolls back a failed session sweep while keeping earlier sessions processed', async () => {
    const saver = await open();
    vi.spyOn(storageClock, 'now').mockReturnValue(day);
    for (const thread of ['a', 'b']) {
      await save(saver, cfg(thread), '001');
      await save(saver, cfg(thread), '002');
    }
    const before = await list(saver, cfg('b'));
    const native = IDBObjectStore.prototype.delete;
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (
      this: IDBObjectStore,
      key: IDBValidKey | IDBKeyRange,
    ) {
      if (
        this.name === 'writes' &&
        key instanceof IDBKeyRange &&
        Array.isArray(key.lower) &&
        key.lower[2] === 'b'
      )
        throw new DOMException('private failure', 'QuotaExceededError');
      return native.call(this, key);
    });
    await expect(saver.sweep({ historyMs: 0, now: 10 * day })).rejects.toEqual(
      new StorageError('quota'),
    );
    expect(await saver.getTuple(cfg('a', '', '001'))).toBeUndefined();
    expect(await list(saver, cfg('b'))).toEqual(before);
  });

  test('treats checkpoints without savedAt as old history but always keeps the latest', async () => {
    const name = `galaxie-retention-legacy-${crypto.randomUUID()}`;
    const saver = await open(name);
    await save(saver, cfg(), '001');
    await save(saver, cfg(), '002');
    const db = await openDatabase(name, 'app', 'user');
    try {
      await transact(db, ['checkpoints'], 'readwrite', async (tx) => {
        const store = tx.objectStore('checkpoints');
        for (const id of ['001', '002']) {
          const row = await requestResult(store.get(['app', 'user', 'session', '', id]));
          delete row.savedAt;
          await requestResult(store.put(row));
        }
      });
    } finally {
      db.close();
    }
    expect(await saver.sweep({ historyMs: 0 })).toEqual({
      prunedCheckpoints: 1,
      expiredSessions: 0,
    });
    expect(await saver.getTuple(cfg())).toBeDefined();
  });

  test('reclaims obsolete parent tasks across sweeps while keeping future checkpoint writes', async () => {
    const databaseName = `galaxie-retention-repeated-${crypto.randomUUID()}`;
    const saver = await open(databaseName);
    const clock = vi.spyOn(storageClock, 'now').mockReturnValue(day);
    const first = await save(saver, cfg(), '001', 3);
    await saver.putWrites(first, [[TASKS, 'old private task']], 'task');
    const second = await save(saver, first, '002', 3);
    await saver.putWrites(second, [[TASKS, 'current parent task']], 'task');
    const secondBefore = await saver.getTuple(second);
    await saver.sweep({ historyMs: 0, now: 10 * day });
    expect(await saver.getTuple(second)).toEqual(secondBefore);

    clock.mockReturnValue(11 * day);
    const third = await save(saver, second, '003', 3);
    await saver.putWrites(third, [['answer', 'current write']], 'task');
    await saver.putWrites(cfg('session', '', 'future'), [[TASKS, 'future task']], 'task');
    const thirdBefore = await saver.getTuple(third);
    await saver.sweep({ historyMs: 0, now: 12 * day });
    expect(await saver.getTuple(third)).toEqual(thirdBefore);
    const db = await openDatabase(databaseName, 'app', 'user');
    try {
      const keys = await transact(db, ['writes'], 'readonly', (tx) =>
        requestResult(tx.objectStore('writes').getAllKeys()),
      );
      expect(keys.map((key) => (key as string[])[4]).sort()).toEqual(['002', '003', 'future']);
    } finally {
      db.close();
    }
  });
});
