// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseByteRequest } from '../src/byte-records.js';
import { IndexedDBSaver } from '../src/index.js';
import { storageClock } from '../src/retention.js';
import { requestResult } from '../src/schema.js';

const savers: IndexedDBSaver[] = [];
const databases: string[] = [];
async function open(
  name = `python-bytes-${crypto.randomUUID()}`,
  principalScope = 'user',
  onError?: (code: string) => void,
): Promise<IndexedDBSaver> {
  if (!databases.includes(name)) databases.push(name);
  const saver = await IndexedDBSaver.open({
    databaseName: name,
    appId: 'app',
    principalScope,
    ...(onError === undefined ? {} : { onError }),
  });
  savers.push(saver);
  return saver;
}
const baseConfig = { sessionId: 'session', namespace: '' };
const checkpoint = { type: 'msgpack', bytes: new Uint8Array([0, 255, 128]) };
const basePut = {
  op: 'put',
  ...baseConfig,
  id: '001',
  parentId: null,
  checkpoint,
  metadata: checkpoint,
  timestamp: '2026-10-30T00:00:00.000Z',
};
const baseWrites = {
  op: 'put-writes',
  ...baseConfig,
  id: '001',
  taskId: 'task',
  taskPath: '~parent',
  writes: [
    { index: -3, channel: '__interrupt__', value: checkpoint, interruptIds: ['pending-id'] },
  ],
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const saver of savers.splice(0)) saver.close();
  for (const name of databases.splice(0)) await requestResult(indexedDB.deleteDatabase(name));
});

test.each(['unknown', null, undefined, 1])(
  'rejects a byte executor outside the closed set: %s',
  (executor) => {
    for (const request of [
      basePut,
      baseWrites,
      { op: 'get', ...baseConfig },
      { op: 'list', ...baseConfig },
      { op: 'delete', sessionId: 'session' },
    ])
      expect(() => parseByteRequest({ ...request, executor })).toThrow();
  },
);

describe
  .skipIf(typeof indexedDB === 'undefined')
  .each([undefined, 'pydantic-ai-python', 'dspy-python', 'adk-js'] as const)(
  'opaque Python checkpoint records: %s',
  (executor) => {
    const config = { ...baseConfig, ...(executor === undefined ? {} : { executor }) };
    const put = { ...basePut, ...config };
    const writes = { ...baseWrites, ...config };
    const deletion = {
      op: 'delete',
      sessionId: config.sessionId,
      ...(executor === undefined ? {} : { executor }),
    };
    test.each(['checkpoints', 'writes'])(
      'rejects an unknown stored executor in %s without affecting another session',
      async (store) => {
        const saver = await open();
        const name = databases.at(-1) as string;
        await saver.byteRecords.request(put);
        await saver.byteRecords.request(writes);
        await saver.byteRecords.request({ ...put, sessionId: 'other-session' });
        const db = await requestResult(indexedDB.open(name));
        try {
          const tx = db.transaction(store, 'readwrite');
          const key = [
            'app',
            'user',
            'session',
            '',
            '001',
            ...(store === 'writes' ? ['task', -3] : []),
          ];
          const row = await requestResult(tx.objectStore(store).get(key));
          row.executor = 'unknown';
          await requestResult(tx.objectStore(store).put(row));
          await expect(saver.byteRecords.request({ op: 'get', ...config })).rejects.toMatchObject({
            code: 'corrupt',
          });
          await expect(saver.exportSession('session')).rejects.toMatchObject({ code: 'corrupt' });
          expect(
            await saver.byteRecords.request({ op: 'get', ...config, sessionId: 'other-session' }),
          ).toMatchObject({ id: '001' });
        } finally {
          db.close();
        }
      },
    );
    test('reopens bytes, pending writes and parent writes; JS reads skip them and export uses markers', async () => {
      const first = await open();
      const name = databases.at(-1) as string;
      await first.byteRecords.request(put);
      await first.byteRecords.request(writes);
      first.close();
      const saver = await open(name);
      const saved = await saver.byteRecords.request({ op: 'get', ...config });
      expect(saved).toMatchObject({
        id: '001',
        checkpoint,
        metadata: checkpoint,
        writes: [{ taskId: 'task', channel: '__interrupt__', value: checkpoint }],
      });
      expect(await saver.getTuple({ configurable: { thread_id: 'session' } })).toBeUndefined();
      const jsRows = [];
      for await (const row of saver.list({ configurable: { thread_id: 'session' } }))
        jsRows.push(row);
      expect(jsRows).toEqual([]);
      const summary = await saver.exportSession('session');
      expect(summary.metadata).toMatchObject({
        checkpointCount: 1,
        pendingInteractionCount: 1,
        firstTimestamp: put.timestamp,
      });
      expect(summary.metadata.unrecoverable).toBeUndefined();
      expect(summary.checkpoints).toBeUndefined();
      expect(JSON.stringify(summary)).not.toContain('AP+A');
      const personal = await saver.exportSession('session', { personalContent: true });
      expect(personal.checkpoints?.[0]?.executor).toBe(executor ?? 'langgraph-python');
      expect(personal.checkpoints?.[0]?.channelValues).toEqual({
        type: 'msgpack',
        bytes: { type: 'base64', data: 'AP+A' },
      });
      await saver.byteRecords.request({ ...put, id: '002', parentId: '001' });
      expect(await saver.byteRecords.request({ op: 'get', ...config })).toMatchObject({
        id: '002',
        parentWrites: [{ channel: '__interrupt__' }],
      });
      expect(
        await saver.byteRecords.request({ op: 'list', ...config, before: '002', limit: 1 }),
      ).toMatchObject([{ id: '001' }]);
      const wrongExecutor = executor === undefined ? 'pydantic-ai-python' : 'langgraph-python';
      expect(
        await saver.byteRecords.request({ op: 'get', ...config, executor: wrongExecutor }),
      ).toBeNull();
      expect(
        await saver.byteRecords.request({ op: 'list', ...config, executor: wrongExecutor }),
      ).toEqual([]);
      const other = await open(name, 'other');
      expect(await other.byteRecords.request({ op: 'get', ...config })).toBeNull();
    });

    test('fences byte mutations after cross-principal takeover and logout', async () => {
      const errors: string[] = [];
      const a = await open(undefined, 'user', (code) => errors.push(code));
      const name = databases.at(-1) as string;
      await a.byteRecords.request(put);
      const b = await open(name, 'other');
      await b.fencing.claim();
      for (const request of [put, writes, deletion])
        await expect(a.byteRecords.request(request)).rejects.toMatchObject({ code: 'fenced' });
      expect(errors).toEqual(['fenced', 'fenced', 'fenced']);
      a.close();
      const fresh = await open(name);
      await fresh.invalidatePrincipal();
      for (const request of [put, writes, deletion])
        await expect(fresh.byteRecords.request(request)).rejects.toMatchObject({
          code: 'invalidated',
        });
      const reopened = await open(name);
      expect(await reopened.byteRecords.request({ op: 'get', ...config })).toBeNull();
    });

    test('retains latest checkpoints, prunes history, deletes threads and expires sessions', async () => {
      const saver = await open();
      const day = 86_400_000;
      const clock = vi.spyOn(storageClock, 'now').mockReturnValue(day);
      await saver.byteRecords.request(put);
      await saver.byteRecords.request(writes);
      clock.mockReturnValue(9 * day);
      await saver.byteRecords.request({ ...put, id: '002', parentId: '001' });
      expect(await saver.sweep({ now: 10 * day })).toMatchObject({ prunedCheckpoints: 1 });
      expect(await saver.byteRecords.request({ op: 'get', ...config })).toMatchObject({
        id: '002',
      });
      await saver.byteRecords.request(deletion);
      expect(await saver.byteRecords.request({ op: 'get', ...config })).toBeNull();
      await saver.byteRecords.request(put);
      await saver.deleteSession('session');
      expect(await saver.byteRecords.request({ op: 'get', ...config })).toBeNull();
      await saver.byteRecords.request(put);
      await saver.sweep({ now: 50 * day });
      expect(await saver.byteRecords.request({ op: 'get', ...config })).toBeNull();
    });
  },
);
