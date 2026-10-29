// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RecoveryStore } from '../../core/src/recovery.js';
import { IndexedDBSaver, StorageError } from '../src/index.js';
import { openDatabase, requestResult, transact } from '../src/schema.js';

const inputDigest = 'a'.repeat(64);
const answer = {
  interactionId: 'question',
  action: 'submit',
  payload: { answer: 'private answer' },
};

const databases: string[] = [];
const savers: IndexedDBSaver[] = [];

async function open(
  databaseName = `galaxie-recovery-${crypto.randomUUID()}`,
  appId = 'app',
  principalScope = 'user',
): Promise<IndexedDBSaver> {
  if (!databases.includes(databaseName)) databases.push(databaseName);
  const saver = await IndexedDBSaver.open({ databaseName, appId, principalScope });
  savers.push(saver);
  return saver;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const saver of savers.splice(0)) saver.close();
  for (const name of databases.splice(0)) await requestResult(indexedDB.deleteDatabase(name));
});

describe.skipIf(typeof indexedDB === 'undefined')('IndexedDB recovery', () => {
  test('exposes the core recovery port on the checkpoint connection', async () => {
    const saver = await open();
    expect(saver).toHaveProperty('recovery');
    const recovery: RecoveryStore = saver.recovery;
    expect(recovery).toBe(saver.recovery);
    expect(await saver.recovery.submissions('session')).toEqual([]);
  });

  test('records session identity once across connections and reopens it without changing the schema', async () => {
    const name = `galaxie-session-record-${crypto.randomUUID()}`;
    const first = await open(name);
    const second = await open(name);
    const record = { agentId: 'tests/agent', agentVersion: '1.0.0' };
    expect(await first.recovery.session('session')).toBeUndefined();
    const values = await Promise.all([
      first.recovery.recordSession('session', record),
      second.recovery.recordSession('session', { ...record, agentVersion: '2.0.0' }),
    ]);
    expect(values[0]).toEqual(values[1]);
    const stored = await first.recovery.session('session');
    expect(stored).toEqual(values[0]);
    const other = await open(name, 'app', 'other');
    expect(await other.recovery.session('session')).toBeUndefined();
    const returned = values[0];
    if (returned === undefined) throw new Error('The session record is missing.');
    Object.assign(returned, { agentId: 'changed' });
    expect(await second.recovery.session('session')).toEqual(stored);
    first.close();
    const reopened = await open(name);
    expect(await reopened.recovery.session('session')).toEqual(stored);
    await reopened.deleteSession('session');
    expect(await reopened.recovery.session('session')).toBeUndefined();
  });

  test.each([
    { v: 99, value: { agentId: 'tests/agent', agentVersion: '1.0.0' } },
    { v: 1, value: { agentId: 'tests/agent', agentVersion: 1 } },
  ])('refuses corrupt session envelopes without replacing them: %#', async (record) => {
    const name = `galaxie-session-corrupt-${crypto.randomUUID()}`;
    const saver = await open(name);
    const db = await openDatabase(name, 'app', 'user');
    try {
      await transact(db, ['meta'], 'readwrite', async (tx) => {
        await requestResult(
          tx.objectStore('meta').put(record, ['app', 'user', 'session', 'session']),
        );
      });
      await expect(saver.recovery.session('session')).rejects.toEqual(new StorageError('corrupt'));
      await expect(
        saver.recovery.recordSession('session', { agentId: 'tests/agent', agentVersion: '1.0.0' }),
      ).rejects.toEqual(new StorageError('corrupt'));
      expect(
        await transact(db, ['meta'], 'readonly', (tx) =>
          requestResult(tx.objectStore('meta').get(['app', 'user', 'session', 'session'])),
        ),
      ).toEqual(record);
    } finally {
      db.close();
    }
  });

  test('accepts once across connections and keeps consumed entries as duplicate receipts', async () => {
    const name = `galaxie-recovery-atomic-${crypto.randomUUID()}`;
    const first = await open(name);
    const second = await open(name);
    const results = await Promise.all([
      first.recovery.acceptSubmission('session', answer),
      second.recovery.acceptSubmission('session', { ...answer, payload: false }),
    ]);
    expect(results.toSorted()).toEqual(['accepted', 'duplicate']);
    const entries = await first.recovery.submissions('session');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('accepted');
    await second.recovery.consumeSubmission('session', answer.interactionId);
    await first.recovery.consumeSubmission('session', answer.interactionId);
    expect(await first.recovery.acceptSubmission('session', answer)).toBe('duplicate');
    expect(await first.recovery.submissions('session')).toEqual([
      { ...entries[0], status: 'consumed' },
    ]);
    await first.recovery.consumeSubmission('session', 'missing');
  });

  test('reopens accepted and consumed answers and terminal write receipts without a schema upgrade', async () => {
    const name = `galaxie-recovery-reopen-${crypto.randomUUID()}`;
    const first = await open(name);
    await first.recovery.acceptSubmission('session', answer);
    await first.recovery.acceptSubmission('session', { ...answer, interactionId: 'resolved' });
    await first.recovery.consumeSubmission('session', 'resolved');
    await first.recovery.recordEffect('session', 'effect', { status: 'planned', inputDigest });
    await first.recovery.recordEffect('session', 'effect', { status: 'dispatched', inputDigest });
    const record = {
      status: 'succeeded' as const,
      inputDigest,
      output: { receipt: [false, 3, null] },
    };
    await first.recovery.recordEffect('session', 'effect', record);
    const expected = await first.recovery.submissions('session');
    first.close();
    const reopened = await open(name);
    expect(await reopened.recovery.submissions('session')).toEqual(expected);
    expect(await reopened.recovery.effect('session', 'effect')).toEqual(record);
    await reopened.recovery.recordEffect('session', 'effect', {
      status: 'outcome_unknown',
      inputDigest,
    });
    expect(await reopened.recovery.effect('session', 'effect')).toEqual(record);
    const raw = await openDatabase(name, 'app', 'user');
    expect(raw.version).toBe(1);
    raw.close();
    await expect(first.recovery.submissions('session')).rejects.toEqual(
      new StorageError('unavailable'),
    );
  });

  test('isolates app, principal and session keys on one database', async () => {
    const name = `galaxie-recovery-scopes-${crypto.randomUUID()}`;
    const first = await open(name);
    const principal = await open(name, 'app', 'other');
    const app = await open(name, 'other', 'user');
    const scopes = [
      { saver: first, session: 'session' },
      { saver: principal, session: 'session' },
      { saver: app, session: 'session' },
      { saver: first, session: 'other' },
    ];
    for (const [index, { saver, session }] of scopes.entries()) {
      await saver.recovery.acceptSubmission(session, { ...answer, payload: index });
      await saver.recovery.recordEffect(session, 'effect', {
        status: 'succeeded',
        inputDigest,
        output: index,
      });
    }
    for (const [index, { saver, session }] of scopes.entries()) {
      expect(await saver.recovery.submissions(session)).toEqual([
        { ...answer, payload: index, status: 'accepted' },
      ]);
      expect(await saver.recovery.effect(session, 'effect')).toEqual({
        status: 'succeeded',
        inputDigest,
        output: index,
      });
    }
    expect(await first.recovery.submissions('missing')).toEqual([]);
    expect(await first.recovery.effect('missing', 'effect')).toBeUndefined();
  });

  test('returns fresh copies of principal answers and capability outputs', async () => {
    const saver = await open();
    await saver.recovery.acceptSubmission('session', answer);
    const entries = await saver.recovery.submissions('session');
    const payload = entries[0]?.payload as { answer: string };
    payload.answer = 'changed';
    expect((await saver.recovery.submissions('session'))[0]?.payload).toEqual(answer.payload);
    await saver.recovery.recordEffect('session', 'effect', {
      status: 'succeeded',
      inputDigest,
      output: { receipt: 'private receipt' },
    });
    const record = await saver.recovery.effect('session', 'effect');
    if (record?.status !== 'succeeded') throw new Error('Missing receipt');
    (record.output as { receipt: string }).receipt = 'changed';
    expect(await saver.recovery.effect('session', 'effect')).toEqual({
      status: 'succeeded',
      inputDigest,
      output: { receipt: 'private receipt' },
    });
  });

  test.each(['accept', 'consume', 'journal'] as const)(
    'waits for strict transaction completion on %s',
    async (operation) => {
      const saver = await open();
      await saver.recovery.acceptSubmission('session', answer);
      const native = IDBDatabase.prototype.transaction;
      let completed = false;
      vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
        this: IDBDatabase,
        ...args: Parameters<IDBDatabase['transaction']>
      ) {
        const tx = native.apply(this, args);
        if (args[1] === 'readwrite') {
          expect(args[2]?.durability).toBe('strict');
          tx.addEventListener('complete', () => {
            completed = true;
          });
        }
        return tx;
      });
      if (operation === 'accept')
        await saver.recovery.acceptSubmission('session', { ...answer, interactionId: 'second' });
      else if (operation === 'consume')
        await saver.recovery.consumeSubmission('session', answer.interactionId);
      else
        await saver.recovery.recordEffect('session', 'effect', { status: 'planned', inputDigest });
      expect(completed).toBe(true);
    },
  );

  test.each(['accept', 'consume', 'journal'] as const)(
    'rejects an aborted %s transaction without partial writes',
    async (operation) => {
      const saver = await open();
      await saver.recovery.acceptSubmission('session', answer);
      const native = IDBObjectStore.prototype.put;
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore['put']>
      ) {
        const request = native.apply(this, args);
        if (this.name === 'inbox' || this.name === 'journal')
          request.addEventListener('success', () => this.transaction.abort());
        return request;
      });
      const result =
        operation === 'accept'
          ? saver.recovery.acceptSubmission('session', { ...answer, interactionId: 'second' })
          : operation === 'consume'
            ? saver.recovery.consumeSubmission('session', answer.interactionId)
            : saver.recovery.recordEffect('session', 'effect', {
                status: 'dispatched',
                inputDigest,
              });
      await expect(result).rejects.toEqual(new StorageError('aborted'));
      expect(await saver.recovery.submissions('session')).toEqual([
        { ...answer, status: 'accepted' },
      ]);
      expect(await saver.recovery.effect('session', 'effect')).toBeUndefined();
    },
  );

  test.each([
    { v: 99, value: { ...answer, status: 'accepted' } },
    { v: 1, value: { ...answer, status: 'unknown' } },
    { v: 1, value: { ...answer, interactionId: 'wrong', status: 'accepted' } },
    { v: 1, value: { ...answer, payload: undefined, status: 'accepted' } },
  ])('rejects a malformed inbox envelope with fixed errors: %#', async (record) => {
    const name = `galaxie-recovery-corrupt-inbox-${crypto.randomUUID()}`;
    const saver = await open(name);
    const db = await openDatabase(name, 'app', 'user');
    try {
      await transact(db, ['inbox'], 'readwrite', async (tx) => {
        await requestResult(
          tx.objectStore('inbox').put(record, ['app', 'user', 'session', answer.interactionId]),
        );
      });
    } finally {
      db.close();
    }
    for (const read of [
      () => saver.recovery.submissions('session'),
      () => saver.recovery.acceptSubmission('session', answer),
      () => saver.recovery.consumeSubmission('session', answer.interactionId),
    ]) {
      await expect(read()).rejects.toEqual(new StorageError('corrupt'));
    }
  });

  test.each([
    { v: 99, value: { status: 'planned', inputDigest } },
    { v: 1, value: { status: 'unknown', inputDigest } },
    { v: 1, value: { status: 'succeeded', inputDigest } },
    { v: 1, value: { status: 'succeeded', inputDigest, output: new Date() } },
    { v: 1, value: { status: 'dispatched', inputDigest: 'invalid' } },
  ])('rejects a malformed journal envelope with fixed errors: %#', async (record) => {
    const name = `galaxie-recovery-corrupt-journal-${crypto.randomUUID()}`;
    const saver = await open(name);
    const db = await openDatabase(name, 'app', 'user');
    try {
      await transact(db, ['journal'], 'readwrite', async (tx) => {
        await requestResult(
          tx.objectStore('journal').put(record, ['app', 'user', 'session', 'effect']),
        );
      });
    } finally {
      db.close();
    }
    await expect(saver.recovery.effect('session', 'effect')).rejects.toEqual(
      new StorageError('corrupt'),
    );
    await expect(
      saver.recovery.recordEffect('session', 'effect', { status: 'planned', inputDigest }),
    ).rejects.toEqual(new StorageError('corrupt'));
  });
});
