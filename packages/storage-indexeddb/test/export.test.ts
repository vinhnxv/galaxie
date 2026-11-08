// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  emptyCheckpoint,
  INTERRUPT,
  type SerializerProtocol,
} from '@langchain/langgraph-checkpoint';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { IndexedDBSaver, StorageError } from '../src/index.js';
import { openDatabase, requestResult, transact } from '../src/schema.js';

const savers: IndexedDBSaver[] = [];
const databases = new Set<string>();
const identity = { agentId: 'tests/export', executorId: 'langgraph-js', agentVersion: '1.0.0' };
const sentence = 'My private learner sentence.';

async function open(
  databaseName = `galaxie-export-${crypto.randomUUID()}`,
  appId = 'app',
  principalScope = 'user',
  serde?: SerializerProtocol,
): Promise<IndexedDBSaver> {
  databases.add(databaseName);
  const saver = await IndexedDBSaver.open({
    databaseName,
    appId,
    principalScope,
    ...(serde === undefined ? {} : { serde }),
  });
  savers.push(saver);
  return saver;
}

async function save(saver: IndexedDBSaver, sessionId = 'session', text = sentence): Promise<void> {
  await saver.recovery.recordSession(sessionId, identity);
  const config = { configurable: { thread_id: sessionId, checkpoint_ns: '' } };
  const first = await saver.put(
    config,
    {
      ...emptyCheckpoint(),
      id: '001',
      ts: '2026-10-29T00:00:00.000Z',
      channel_values: { text },
    },
    { source: 'input', step: -1, parents: {} },
    {},
  );
  await saver.putWrites(first, [[INTERRUPT, [{ id: 'old', value: text }]]], 'old-task');
  const latest = await saver.put(
    first,
    {
      ...emptyCheckpoint(),
      id: '002',
      ts: '2026-10-30T00:00:00.000Z',
      channel_values: { text },
    },
    { source: 'loop', step: 0, parents: {} },
    {},
  );
  await saver.putWrites(
    latest,
    [
      [INTERRUPT, [{ id: 'pending', value: text }]],
      ['text', text],
    ],
    'task',
  );
  await saver.recovery.acceptSubmission(sessionId, {
    interactionId: 'answer',
    action: 'submit',
    payload: { text },
  });
  await saver.recovery.acceptSubmission(sessionId, {
    interactionId: 'consumed',
    action: 'submit',
    payload: { text },
  });
  await saver.recovery.consumeSubmission(sessionId, 'consumed');
  await saver.recovery.recordEffect(sessionId, 'receipt', {
    status: 'succeeded',
    inputDigest: 'a'.repeat(64),
    output: { privateReceipt: text },
  });
  await saver.recovery.recordEffect(sessionId, 'unknown', {
    status: 'outcome_unknown',
    inputDigest: 'b'.repeat(64),
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const saver of savers.splice(0)) saver.close();
  for (const name of databases) await requestResult(indexedDB.deleteDatabase(name));
  databases.clear();
});

describe.skipIf(typeof indexedDB === 'undefined')('session export', () => {
  test('exports identical metadata for stamped and unstamped recovery records', async () => {
    const name = `galaxie-export-stamps-${crypto.randomUUID()}`;
    const saver = await open(name);
    const db = await openDatabase(name, 'app', 'user');
    try {
      await transact(db, ['meta', 'inbox', 'journal'], 'readwrite', async (tx) => {
        for (const stamped of [false, true]) {
          const sessionId = stamped ? 'stamped' : 'unstamped';
          const stamp = stamped ? { formatVersion: 1 } : {};
          await requestResult(
            tx.objectStore('meta').put(
              { v: 1, value: { ...identity, ...stamp } },
              ['app', 'user', 'session', sessionId],
            ),
          );
          for (const status of ['accepted', 'consumed'])
            await requestResult(
              tx.objectStore('inbox').put(
                {
                  v: 1,
                  value: {
                    interactionId: status,
                    action: 'submit',
                    payload: sentence,
                    status,
                    ...stamp,
                  },
                },
                ['app', 'user', sessionId, status],
              ),
            );
          await requestResult(
            tx.objectStore('journal').put(
              {
                v: 1,
                value: {
                  status: 'succeeded',
                  inputDigest: 'a'.repeat(64),
                  output: sentence,
                  ...stamp,
                },
              },
              ['app', 'user', sessionId, 'receipt'],
            ),
          );
        }
      });
      const unstamped = await saver.exportSession('unstamped');
      const stamped = await saver.exportSession('stamped');
      expect(stamped.format).toBe('galaxie.session-export/1');
      expect(stamped.metadata).toEqual(unstamped.metadata);
      expect(stamped.metadata.agent).toEqual(identity);
      expect(Object.keys(stamped.metadata.agent ?? {}).sort()).toEqual([
        'agentId',
        'agentVersion',
        'executorId',
      ]);
      expect(Object.isFrozen(stamped.metadata.agent)).toBe(true);
      expect(JSON.stringify(stamped)).not.toContain('formatVersion');
    } finally {
      db.close();
    }
  });

  test.each(['meta', 'inbox', 'journal'] as const)(
    'refuses exports containing a newer recovery record in %s',
    async (store) => {
      const name = `galaxie-export-newer-${crypto.randomUUID()}`;
      const saver = await open(name);
      const db = await openDatabase(name, 'app', 'user');
      const records = {
        meta: {
          key: ['app', 'user', 'session', 'session'],
          value: { ...identity, formatVersion: 2 },
        },
        inbox: {
          key: ['app', 'user', 'session', 'question'],
          value: {
            interactionId: 'question',
            action: 'submit',
            payload: sentence,
            status: 'accepted',
            formatVersion: 2,
          },
        },
        journal: {
          key: ['app', 'user', 'session', 'receipt'],
          value: {
            status: 'succeeded',
            inputDigest: 'a'.repeat(64),
            output: sentence,
            formatVersion: 2,
          },
        },
      };
      try {
        await transact(db, [store], 'readwrite', (tx) =>
          requestResult(
            tx.objectStore(store).put({ v: 1, value: records[store].value }, records[store].key),
          ),
        );
        for (const personalContent of [false, true])
          await expect(saver.exportSession('session', { personalContent })).rejects.toEqual(
            new StorageError('newer_record'),
          );
      } finally {
        db.close();
      }
    },
  );

  test('defaults to frozen content-free metadata, with recovery status counts only', async () => {
    const saver = await open();
    await save(saver);
    const exported = await saver.exportSession('session');
    expect(exported).toEqual({
      format: 'galaxie.session-export/1',
      appId: 'app',
      sessionId: 'session',
      exportedAt: expect.any(String),
      personalContent: false,
      metadata: {
        agent: identity,
        checkpointCount: 2,
        firstTimestamp: '2026-10-29T00:00:00.000Z',
        lastTimestamp: '2026-10-30T00:00:00.000Z',
        pendingInteractionCount: 1,
        recovery: {
          submissions: { count: 2, accepted: 1, consumed: 1 },
          effects: {
            count: 2,
            planned: 0,
            dispatched: 0,
            succeeded: 1,
            failed: 0,
            outcome_unknown: 1,
          },
        },
      },
    });
    expect(Number.isFinite(Date.parse(exported.exportedAt))).toBe(true);
    expect(JSON.stringify(exported)).not.toContain(sentence);
    expect(JSON.stringify(exported)).not.toContain('a'.repeat(64));
    expect(JSON.stringify(exported)).not.toContain('privateReceipt');
    for (const value of [
      exported,
      exported.metadata,
      exported.metadata.agent,
      exported.metadata.recovery,
      exported.metadata.recovery.submissions,
      exported.metadata.recovery.effects,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);
  });

  test('exports checkpoints oldest first with parent IDs and ordered writes only on exact true', async () => {
    const saver = await open();
    await save(saver);
    for (const personalContent of [false, undefined, 'true', 1, {}]) {
      const exported = await saver.exportSession('session', {
        personalContent: personalContent as boolean,
      });
      expect(exported.personalContent).toBe(false);
      expect(exported).not.toHaveProperty('checkpoints');
      expect(JSON.stringify(exported)).not.toContain(sentence);
    }
    const exported = await saver.exportSession('session', { personalContent: true });
    expect(exported.personalContent).toBe(true);
    expect(exported.checkpoints).toEqual([
      {
        id: '001',
        parentId: null,
        namespace: '',
        timestamp: '2026-10-29T00:00:00.000Z',
        channelValues: { text: sentence },
        pendingWrites: [['old-task', INTERRUPT, [{ id: 'old', value: sentence }]]],
      },
      {
        id: '002',
        parentId: '001',
        namespace: '',
        timestamp: '2026-10-30T00:00:00.000Z',
        channelValues: { text: sentence },
        pendingWrites: [
          ['task', INTERRUPT, [{ id: 'pending', value: sentence }]],
          ['task', 'text', sentence],
        ],
      },
    ]);
    expect(Object.isFrozen(exported.checkpoints)).toBe(true);
    expect(Object.isFrozen(exported.checkpoints?.[1]?.channelValues)).toBe(true);
    expect(Object.isFrozen(exported.checkpoints?.[1]?.pendingWrites[0])).toBe(true);
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);
    expect(JSON.stringify(exported)).not.toContain('privateReceipt');
  });

  test('isolates app, principal and session even in a shared database', async () => {
    const name = `galaxie-export-scopes-${crypto.randomUUID()}`;
    const own = await open(name);
    const principal = await open(name, 'app', 'other');
    const app = await open(name, 'other', 'user');
    await save(own, 'session', 'own');
    await save(principal, 'session', 'other principal');
    await save(app, 'session', 'other app');
    await save(own, 'another', 'another session');
    const exported = await own.exportSession('session', { personalContent: true });
    expect(exported.metadata.checkpointCount).toBe(2);
    expect(exported.checkpoints?.map((row) => row.channelValues)).toEqual([
      { text: 'own' },
      { text: 'own' },
    ]);
    await save(principal, 'foreign');
    await save(app, 'foreign');
    await expect(own.exportSession('foreign')).rejects.toMatchObject({ code: 'invalid' });
  });

  test('orders interleaved namespaces and counts only their latest distinct interrupts', async () => {
    const saver = await open();
    for (const row of [
      {
        namespace: 'child:task',
        id: '001',
        parent: undefined,
        text: 'child-old',
        ids: ['stale-child'],
      },
      { namespace: '', id: '002', parent: '001', text: 'root-new', ids: ['shared'] },
      {
        namespace: 'child:task',
        id: '003',
        parent: '001',
        text: 'child-new',
        ids: ['shared', 'child'],
      },
      { namespace: '', id: '001', parent: undefined, text: 'root-old', ids: ['stale-root'] },
    ]) {
      const config = await saver.put(
        {
          configurable: {
            thread_id: 'session',
            checkpoint_ns: row.namespace,
            ...(row.parent === undefined ? {} : { checkpoint_id: row.parent }),
          },
        },
        {
          ...emptyCheckpoint(),
          id: row.id,
          ts: '2026-10-30T00:00:00.000Z',
          channel_values: { text: row.text },
        },
        { source: 'loop', step: 0, parents: {} },
        {},
      );
      await saver.putWrites(
        config,
        [[INTERRUPT, row.ids.map((id) => ({ id, value: row.text }))]],
        'task',
      );
    }
    expect((await saver.exportSession('session')).metadata).toMatchObject({
      checkpointCount: 4,
      pendingInteractionCount: 2,
    });
    const exported = await saver.exportSession('session', { personalContent: true });
    expect(
      exported.checkpoints?.map((row) => [row.id, row.namespace, row.parentId, row.channelValues]),
    ).toEqual([
      ['001', '', null, { text: 'root-old' }],
      ['001', 'child:task', null, { text: 'child-old' }],
      ['002', '', '001', { text: 'root-new' }],
      ['003', 'child:task', '001', { text: 'child-new' }],
    ]);
    expect(exported.checkpoints?.map((row) => row.pendingWrites)).toEqual([
      [['task', INTERRUPT, [{ id: 'stale-root', value: 'root-old' }]]],
      [['task', INTERRUPT, [{ id: 'stale-child', value: 'child-old' }]]],
      [['task', INTERRUPT, [{ id: 'shared', value: 'root-new' }]]],
      [
        [
          'task',
          INTERRUPT,
          [
            { id: 'shared', value: 'child-new' },
            { id: 'child', value: 'child-new' },
          ],
        ],
      ],
    ]);
  });

  test('rejects unknown and deleted sessions with fixed content-free errors', async () => {
    const saver = await open();
    await expect(saver.exportSession(sentence)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'invalid',
      message: 'The storage request is invalid.',
    });
    await save(saver);
    await saver.deleteSession('session');
    await expect(saver.exportSession('session', { personalContent: true })).rejects.toMatchObject({
      code: 'invalid',
    });
    try {
      await saver.exportSession(sentence);
    } catch (error) {
      expect(error).not.toHaveProperty('cause');
      expect(String(error)).not.toContain(sentence);
    }
  });

  test('allows reads after ownership loss but rejects logout even after the principal is recreated', async () => {
    const name = `galaxie-export-logout-${crypto.randomUUID()}`;
    const old = await open(name);
    await save(old);
    const owner = await open(name);
    await owner.fencing.claim();
    expect((await old.exportSession('session')).metadata.checkpointCount).toBe(2);
    await owner.invalidatePrincipal();
    const fresh = await open(name);
    await save(fresh);
    await expect(old.exportSession('session', { personalContent: true })).rejects.toMatchObject({
      code: 'invalidated',
    });
    await expect(owner.exportSession('session')).rejects.toMatchObject({ code: 'invalidated' });
    expect((await fresh.exportSession('session')).metadata.agent).toEqual(identity);
  });

  test('uses the saver serde and replaces unconvertible channel and write values without throwing', async () => {
    const values: unknown[] = [];
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const serde: SerializerProtocol = {
      async dumpsTyped(value) {
        values.push(value);
        return ['fixture', new TextEncoder().encode(String(values.length - 1))];
      },
      async loadsTyped(_type, bytes) {
        return values[Number(new TextDecoder().decode(bytes as Uint8Array))];
      },
    };
    const saver = await open(undefined, 'app', 'user', serde);
    const cfg = await saver.put(
      { configurable: { thread_id: 'session' } },
      {
        ...emptyCheckpoint(),
        id: '001',
        ts: '2026-10-30T00:00:00.000Z',
        channel_values: { bytes: new Uint8Array([0, 128, 255]), cyclic, unsupported: 1n },
      },
      { source: 'loop', step: 0, parents: {} },
      {},
    );
    await saver.putWrites(
      cfg,
      [
        [
          'unsupported',
          () => {
            throw new Error(sentence);
          },
        ],
      ],
      'task',
    );
    const exported = await saver.exportSession('session', { personalContent: true });
    expect(exported.metadata.agent).toBeNull();
    expect(exported.checkpoints?.[0]?.channelValues).toEqual({
      bytes: { type: 'base64', data: 'AID/' },
      cyclic: { self: '[unavailable]' },
      unsupported: '[unavailable]',
    });
    expect(exported.checkpoints?.[0]?.pendingWrites).toEqual([
      ['task', 'unsupported', '[unavailable]'],
    ]);
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);
  });

  test('marks unreadable checkpoints without returning serializer errors or mutating records', async () => {
    const saver = await open();
    await save(saver);
    vi.spyOn(saver.serde, 'loadsTyped').mockRejectedValue(new Error(sentence));
    const exported = await saver.exportSession('session', { personalContent: true });
    expect(exported.metadata.unrecoverable).toBe(true);
    expect(exported.metadata.firstTimestamp).toBeNull();
    expect(exported.checkpoints?.map((row) => row.channelValues)).toEqual([
      '[unavailable]',
      '[unavailable]',
    ]);
    expect(JSON.stringify(exported)).not.toContain(sentence);
    vi.restoreAllMocks();
    expect((await saver.exportSession('session')).metadata).not.toHaveProperty('unrecoverable');
  });

  test('rejects an export if logout occurs while asynchronous decoding is in progress', async () => {
    const saver = await open();
    await save(saver);
    const native = saver.serde.loadsTyped.bind(saver.serde);
    let release: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    vi.spyOn(saver.serde, 'loadsTyped').mockImplementation(async (type, bytes) => {
      entered = true;
      await paused;
      return native(type, bytes);
    });
    const exporting = saver.exportSession('session', { personalContent: true });
    const rejection = expect(exporting).rejects.toMatchObject({ code: 'invalidated' });
    await expect.poll(() => entered).toBe(true);
    await saver.invalidatePrincipal();
    release?.();
    await rejection;
  });
});
