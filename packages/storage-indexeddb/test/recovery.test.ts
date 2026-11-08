// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RecoveryStore } from '../../core/src/recovery.js';
import { IndexedDBSaver, StorageError, type StorageErrorCode } from '../src/index.js';
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
  onError?: (code: StorageErrorCode) => void,
): Promise<IndexedDBSaver> {
  if (!databases.includes(databaseName)) databases.push(databaseName);
  const saver = await IndexedDBSaver.open({
    databaseName,
    appId,
    principalScope,
    ...(onError === undefined ? {} : { onError }),
  });
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
    const record = { agentId: 'tests/agent', executorId: 'langgraph-js', agentVersion: '1.0.0' };
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
    { v: 1, value: { agentId: 'a', agentVersion: '1', executorId: 'python', extra: true } },
    { v: 1, value: { agentId: 'a', agentVersion: '1', executorId: '' } },
    { v: 1, value: { agentId: 'a', agentVersion: '1', executorId: 1 } },
    { v: 1, value: { agentId: 'a', agentVersion: '1', formatVersion: 1 } },
    { v: 99, value: { agentId: 'tests/agent', executorId: 'langgraph-js', agentVersion: '1.0.0' } },
    { v: 1, value: { agentId: 'tests/agent', executorId: 'langgraph-js', agentVersion: 1 } },
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
        saver.recovery.recordSession('session', {
          agentId: 'tests/agent',
          executorId: 'langgraph-js',
          agentVersion: '1.0.0',
        }),
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

  test('reads legacy session identity after reopen without rewriting its v1 envelope', async () => {
    const name = `galaxie-legacy-${crypto.randomUUID()}`;
    const first = await open(name);
    const db = await openDatabase(name, 'app', 'user');
    const key = ['app', 'user', 'session', 'session'];
    const record = { v: 1, value: { agentId: 'tests/legacy', agentVersion: '1' } };
    await transact(db, ['meta'], 'readwrite', (tx) =>
      requestResult(tx.objectStore('meta').put(record, key)),
    );
    first.close();
    const reopened = await open(name);
    const expected = { ...record.value, executorId: 'langgraph-js' };
    expect(await reopened.recovery.session('session')).toEqual(expected);
    expect(
      await reopened.recovery.recordSession('session', {
        ...expected,
        executorId: 'langgraph-python',
      }),
    ).toEqual(expected);
    expect((await reopened.exportSession('session')).metadata.agent).toEqual(expected);
    expect(
      await transact(db, ['meta'], 'readonly', (tx) =>
        requestResult(tx.objectStore('meta').get(key)),
      ),
    ).toEqual(record);
    expect(db.version).toBe(1);
    db.close();
  });

  test('reads unstamped recovery records without rewriting them', async () => {
    const name = `galaxie-unstamped-${crypto.randomUUID()}`;
    const saver = await open(name);
    const db = await openDatabase(name, 'app', 'user');
    const identity = { agentId: 'tests/agent', agentVersion: '1', executorId: 'langgraph-js' };
    const entries = [
      { interactionId: 'accepted', action: 'submit', payload: true, status: 'accepted' },
      { interactionId: 'consumed', action: 'submit', payload: null, status: 'consumed' },
    ];
    const effects = [
      { status: 'planned', inputDigest },
      { status: 'dispatched', inputDigest },
      { status: 'succeeded', inputDigest, output: { receipt: true } },
      { status: 'failed', inputDigest },
      { status: 'outcome_unknown', inputDigest },
    ];
    try {
      await transact(db, ['meta', 'inbox', 'journal'], 'readwrite', async (tx) => {
        await requestResult(
          tx
            .objectStore('meta')
            .put({ v: 1, value: identity }, ['app', 'user', 'session', 'session']),
        );
        for (const entry of entries)
          await requestResult(
            tx
              .objectStore('inbox')
              .put({ v: 1, value: entry }, ['app', 'user', 'session', entry.interactionId]),
          );
        for (const record of effects)
          await requestResult(
            tx
              .objectStore('journal')
              .put({ v: 1, value: record }, ['app', 'user', 'session', record.status]),
          );
      });
      expect(await saver.recovery.session('session')).toStrictEqual(identity);
      expect(await saver.recovery.submissions('session')).toStrictEqual(entries);
      for (const record of effects)
        expect(await saver.recovery.effect('session', record.status)).toStrictEqual(record);
      await transact(db, ['meta', 'inbox', 'journal'], 'readonly', async (tx) => {
        expect(
          await requestResult(tx.objectStore('meta').get(['app', 'user', 'session', 'session'])),
        ).toStrictEqual({ v: 1, value: identity });
        for (const entry of entries)
          expect(
            await requestResult(
              tx.objectStore('inbox').get(['app', 'user', 'session', entry.interactionId]),
            ),
          ).toStrictEqual({ v: 1, value: entry });
        for (const record of effects)
          expect(
            await requestResult(
              tx.objectStore('journal').get(['app', 'user', 'session', record.status]),
            ),
          ).toStrictEqual({ v: 1, value: record });
      });
    } finally {
      db.close();
    }
  });

  test('persists format stamps on identities, submissions and all effect statuses', async () => {
    const saver = await open();
    const identity = {
      formatVersion: 1,
      agentId: 'tests/agent',
      agentVersion: '1',
      executorId: 'langgraph-js',
    };
    expect(await saver.recovery.recordSession('session', identity)).toEqual(identity);
    expect(await saver.recovery.session('session')).toEqual(identity);
    const entry = { ...answer, formatVersion: 1 };
    expect(await saver.recovery.acceptSubmission('session', entry)).toBe('accepted');
    expect(await saver.recovery.submissions('session')).toEqual([{ ...entry, status: 'accepted' }]);
    for (const status of [
      'planned',
      'dispatched',
      'succeeded',
      'failed',
      'outcome_unknown',
    ] as const) {
      const record =
        status === 'succeeded'
          ? { formatVersion: 1, status, inputDigest, output: { receipt: true } }
          : { formatVersion: 1, status, inputDigest };
      await saver.recovery.recordEffect('session', status, record);
      expect(await saver.recovery.effect('session', status)).toEqual(record);
    }
  });

  test.each([false, true])('preserves the submission stamp when consuming: %s', async (stamped) => {
    const name = `galaxie-consume-stamp-${crypto.randomUUID()}`;
    const saver = await open(name);
    const db = await openDatabase(name, 'app', 'user');
    const key = ['app', 'user', 'session', 'question'];
    const entry = {
      interactionId: 'question',
      action: 'submit',
      payload: { answer: true },
      status: 'accepted',
      ...(stamped ? { formatVersion: 1 } : {}),
    };
    try {
      await transact(db, ['inbox'], 'readwrite', (tx) =>
        requestResult(tx.objectStore('inbox').put({ v: 1, value: entry }, key)),
      );
      await saver.recovery.consumeSubmission('session', 'question');
      await saver.recovery.consumeSubmission('session', 'question');
      expect(await saver.recovery.submissions('session')).toStrictEqual([
        { ...entry, status: 'consumed' },
      ]);
      expect(
        await transact(db, ['inbox'], 'readonly', (tx) =>
          requestResult(tx.objectStore('inbox').get(key)),
        ),
      ).toStrictEqual({ v: 1, value: { ...entry, status: 'consumed' } });
    } finally {
      db.close();
    }
  });

  test.each([
    { formatVersion: 2, code: 'newer_record' },
    { formatVersion: 999, code: 'newer_record' },
    { formatVersion: 0, code: 'corrupt' },
    { formatVersion: -1, code: 'corrupt' },
    { formatVersion: 1.5, code: 'corrupt' },
    { formatVersion: '1', code: 'corrupt' },
    { formatVersion: null, code: 'corrupt' },
    { formatVersion: true, code: 'corrupt' },
  ] as const)(
    'refuses unsupported record versions without replacing stored data: %#',
    async ({ formatVersion, code }) => {
      const name = `galaxie-record-version-${crypto.randomUUID()}`;
      const onError = vi.fn();
      const saver = await open(name, 'app', 'user', onError);
      const db = await openDatabase(name, 'app', 'user');
      const identity = { agentId: 'tests/agent', agentVersion: '1', executorId: 'langgraph-js' };
      const session = { v: 1, value: { ...identity, formatVersion } };
      const entry = {
        v: 1,
        value: {
          interactionId: 'question',
          action: 'submit',
          payload: 'private answer',
          status: 'accepted',
          formatVersion,
        },
      };
      const planned = { v: 1, value: { status: 'planned', inputDigest, formatVersion } };
      const succeeded = {
        v: 1,
        value: { status: 'succeeded', inputDigest, output: 'private receipt', formatVersion },
      };
      try {
        await transact(db, ['meta', 'inbox', 'journal'], 'readwrite', async (tx) => {
          await requestResult(
            tx.objectStore('meta').put(session, ['app', 'user', 'session', 'session']),
          );
          await requestResult(
            tx.objectStore('inbox').put(entry, ['app', 'user', 'session', 'question']),
          );
          await requestResult(
            tx.objectStore('journal').put(planned, ['app', 'user', 'session', 'planned']),
          );
          await requestResult(
            tx.objectStore('journal').put(succeeded, ['app', 'user', 'session', 'succeeded']),
          );
        });
        const operations = [
          () => saver.recovery.session('session'),
          () => saver.recovery.recordSession('session', identity),
          () => saver.recovery.submissions('session'),
          () => saver.recovery.acceptSubmission('session', answer),
          () => saver.recovery.consumeSubmission('session', 'question'),
          () => saver.recovery.effect('session', 'planned'),
          () => saver.recovery.effect('session', 'succeeded'),
          () =>
            saver.recovery.recordEffect('session', 'planned', { status: 'planned', inputDigest }),
          () =>
            saver.recovery.recordEffect('session', 'succeeded', { status: 'planned', inputDigest }),
        ];
        for (const operation of operations)
          await expect(operation()).rejects.toEqual(new StorageError(code));
        expect(onError.mock.calls).toEqual(operations.map(() => [code]));
        await transact(db, ['meta', 'inbox', 'journal'], 'readonly', async (tx) => {
          expect(
            await requestResult(tx.objectStore('meta').get(['app', 'user', 'session', 'session'])),
          ).toEqual(session);
          expect(
            await requestResult(
              tx.objectStore('inbox').get(['app', 'user', 'session', 'question']),
            ),
          ).toEqual(entry);
          expect(
            await requestResult(
              tx.objectStore('journal').get(['app', 'user', 'session', 'planned']),
            ),
          ).toEqual(planned);
          expect(
            await requestResult(
              tx.objectStore('journal').get(['app', 'user', 'session', 'succeeded']),
            ),
          ).toEqual(succeeded);
        });
      } finally {
        db.close();
      }
    },
  );

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
