// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { RunnableConfig } from '@langchain/core/runnables';
import {
  type BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  ERROR,
  emptyCheckpoint,
  INTERRUPT,
  MemorySaver,
  RESUME,
  SCHEDULED,
  TASKS,
} from '@langchain/langgraph-checkpoint';
import { afterEach, expect, it, vi } from 'vitest';
import { IndexedDBSaver, StorageError } from '../src/index.js';
import { openDatabase, requestResult, transact } from '../src/schema.js';

const databases: string[] = [];
const savers: IndexedDBSaver[] = [];

async function open(
  databaseName = `galaxie-saver-${crypto.randomUUID()}`,
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

function config(thread = 'thread', namespace = '', id?: string): RunnableConfig {
  return {
    configurable: {
      thread_id: thread,
      checkpoint_ns: namespace,
      ...(id === undefined ? {} : { checkpoint_id: id }),
    },
  };
}

function checkpoint(id: string, v = 4): Checkpoint {
  return {
    ...emptyCheckpoint(),
    id,
    v,
    ts: '2026-10-29T00:00:00.000Z',
    channel_values: { answer: ['yes', false, 3] },
  };
}

async function save(
  saver: BaseCheckpointSaver,
  cfg: RunnableConfig,
  id: string,
  step = 1,
  v = 4,
): Promise<RunnableConfig> {
  return saver.put(cfg, checkpoint(id, v), { source: 'loop', step, parents: {} }, {});
}

async function entries(
  saver: BaseCheckpointSaver,
  cfg: RunnableConfig = {},
  options?: CheckpointListOptions,
): Promise<unknown[]> {
  const result: unknown[] = [];
  for await (const tuple of saver.list(cfg, options)) result.push(tuple);
  return result;
}

it('matches MemorySaver for ordered threads, namespaces, lookups, filters and deletion', async () => {
  const actual = await open();
  const oracle = new MemorySaver();
  for (const saver of [oracle, actual]) {
    for (const thread of ['z', '10', 'a', '2']) {
      for (const namespace of ['z', '10', 'a', '2', 'child:subgraph', '']) {
        const first = await save(saver, config(thread, namespace), '001', 0);
        await save(saver, first, '010', 1);
        await save(saver, first, '002', 2);
        // Replacing a checkpoint must not move its thread or namespace.
        await save(saver, first, '002', 2);
      }
    }
  }
  const queries: [RunnableConfig, CheckpointListOptions?][] = [
    [{}],
    [config('z')],
    [{ configurable: { checkpoint_ns: 'child:subgraph' } }],
    [config('z', 'a', '002')],
    [{}, { before: config('ignored', '', '010') }],
    [{}, { limit: 5 }],
    [{}, { limit: 0 }],
    [{}, { limit: -1 }],
    [{}, { filter: { step: 1, source: 'loop' }, limit: 8 }],
    [{}, { filter: { step: 99 } }],
    [config('missing')],
  ];
  for (const [cfg, options] of queries)
    expect(await entries(actual, cfg, options)).toEqual(await entries(oracle, cfg, options));
  for (const cfg of [
    {},
    config('z'),
    config('z', 'a', '001'),
    config('missing'),
    config('z', 'missing'),
    { configurable: { thread_id: 'z', checkpoint_ns: 'a', thread_ts: '001' } },
  ])
    expect(await actual.getTuple(cfg)).toEqual(await oracle.getTuple(cfg));
  for (const saver of [oracle, actual]) {
    await saver.deleteThread('z');
    await saver.deleteThread('missing');
    await save(saver, config('z'), '003');
  }
  expect(await entries(actual)).toEqual(await entries(oracle));
});

it('matches pending-write replacement, taskPath code-point order and legacy pending sends', async () => {
  const actual = await open();
  const oracle = new MemorySaver();
  for (const saver of [oracle, actual]) {
    const first = await save(saver, config(), '001');
    await saver.putWrites(first, [['answer', 'first']], 'z', 'path:z');
    await saver.putWrites(first, [['answer', 'ignored']], 'z', 'path:a');
    await saver.putWrites(
      first,
      [
        [ERROR, { error: 1 }],
        [INTERRUPT, { id: 'i' }],
      ],
      'z',
    );
    await saver.putWrites(
      first,
      [
        [ERROR, { error: 2 }],
        [INTERRUPT, { id: 'j' }],
      ],
      'z',
    );
    await saver.putWrites(
      first,
      [
        [RESUME, false],
        [SCHEDULED, 2],
      ],
      'a',
    );
    await saver.putWrites(
      first,
      [
        ['answer', 1],
        ['answer', 2],
      ],
      'with,comma',
      'path:a',
    );
    await saver.putWrites(first, [['answer', 3]], 'astral', '\u{10000}');
    await saver.putWrites(first, [['answer', 4]], 'bmp', '\uE000');
    await saver.putWrites(first, [[TASKS, { node: 'z', args: 2 }]], 'send:z', 'z');
    await saver.putWrites(first, [[TASKS, { node: 'a', args: 1 }]], 'send:a', 'a');
    await save(saver, first, '002', 2, 3);
    // Writes may arrive before their checkpoint.
    await saver.putWrites(config('orphan', '', '001'), [['answer', 9]], 'task');
  }
  expect(await actual.getTuple(config())).toEqual(await oracle.getTuple(config()));
  expect(await entries(actual)).toEqual(await entries(oracle));
  for (const saver of [oracle, actual]) await saver.deleteThread('thread');
  for (const saver of [oracle, actual]) await save(saver, config(), '001');
  expect(await entries(actual)).toEqual(await entries(oracle));
});

it('survives reopen with equal tuples, pending writes and insertion order', async () => {
  const name = `galaxie-reopen-${crypto.randomUUID()}`;
  const saver = await open(name);
  const first = await save(saver, config('z', 'child:one'), '001');
  await saver.putWrites(first, [['answer', false]], 'task', 'path');
  await save(saver, first, '002');
  await save(saver, config('a'), '001');
  const before = await entries(saver);
  saver.close();
  saver.close();
  const reopened = await open(name);
  expect(await entries(reopened)).toEqual(before);
  expect(await reopened.getTuple(config('z', 'child:one', '001'))).toEqual(before[1]);
  await expect(saver.getTuple(config())).rejects.toMatchObject({ code: 'unavailable' });
});

it('isolates apps and principals in one database, including thread deletion', async () => {
  const name = `galaxie-isolation-${crypto.randomUUID()}`;
  const first = await open(name);
  const otherPrincipal = await open(name, 'app', 'other');
  const otherApp = await open(name, 'other', 'user');
  for (const [index, saver] of [first, otherPrincipal, otherApp].entries()) {
    const cfg = await save(saver, config(), '001', index);
    await saver.putWrites(cfg, [['answer', index]], 'task');
  }
  for (const [index, saver] of [first, otherPrincipal, otherApp].entries()) {
    expect(await entries(saver)).toHaveLength(1);
    expect((await saver.getTuple(config()))?.metadata?.step).toBe(index);
  }
  await first.deleteThread('thread');
  expect(await entries(first)).toEqual([]);
  expect(await first.getTuple(config())).toBeUndefined();
  for (const saver of [otherPrincipal, otherApp]) {
    expect(await entries(saver)).toHaveLength(1);
    expect((await saver.getTuple(config()))?.pendingWrites).toHaveLength(1);
  }
});

it('round-trips a bytes-typed pending value without dropping the tag', async () => {
  const databaseName = `galaxie-bytes-${crypto.randomUUID()}`;
  databases.push(databaseName);
  const fallback = new MemorySaver().serde;
  const saver = await IndexedDBSaver.open({
    appId: 'app',
    principalScope: 'user',
    databaseName,
    serde: {
      dumpsTyped: async (value: unknown) =>
        value instanceof Uint8Array ? ['bytes', value] : fallback.dumpsTyped(value),
      loadsTyped: async (type: string, value: Uint8Array | string) =>
        type === 'bytes' ? value : fallback.loadsTyped(type, value),
    },
  });
  savers.push(saver);
  const cfg = await save(saver, config(), '001');
  await saver.putWrites(cfg, [['binary', new Uint8Array([0, 255, 17])]], 'task');
  expect((await saver.getTuple(cfg))?.pendingWrites).toEqual([
    ['task', 'binary', new Uint8Array([0, 255, 17])],
  ]);
});

it.each(['checkpoints', 'writes'])(
  'waits for strict transaction completion in %s',
  async (store) => {
    const saver = await open();
    const cfg = await save(saver, config(), '001');
    const native = IDBDatabase.prototype.transaction;
    let completed = false;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase['transaction']>
    ) {
      const tx = native.apply(this, args);
      if (args[1] === 'readwrite' && tx.objectStoreNames.contains(store)) {
        expect(args[2]?.durability).toBe('strict');
        tx.addEventListener('complete', () => {
          completed = true;
        });
      }
      return tx;
    });
    if (store === 'checkpoints') await save(saver, cfg, '002');
    else await saver.putWrites(cfg, [['answer', 1]], 'task');
    expect(completed).toBe(true);
  },
);

it.each(['checkpoints', 'writes'])(
  'rejects an aborted %s transaction without partial writes',
  async (store) => {
    const saver = await open();
    const cfg = await save(saver, config(), '001');
    const before = await entries(saver);
    const native = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      const request = native.apply(this, args);
      if (this.name === store) request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    const result =
      store === 'checkpoints'
        ? save(saver, cfg, '002')
        : saver.putWrites(
            cfg,
            [
              ['answer', 1],
              ['answer', 2],
            ],
            'task',
          );
    await expect(result).rejects.toMatchObject({ code: 'aborted' });
    expect(await entries(saver)).toEqual(before);
  },
);

it('rejects corrupted record envelopes and deserialization failures with fixed errors', async () => {
  const name = `galaxie-corrupt-${crypto.randomUUID()}`;
  const saver = await open(name);
  await save(saver, config(), '001');
  saver.serde.loadsTyped = async () => {
    throw new Error('private completion or host text');
  };
  await expect(saver.getTuple(config())).rejects.toEqual(new StorageError('corrupt'));
  const reopened = await open(name);
  const db = await openDatabase(name, 'app', 'user');
  try {
    await transact(db, ['checkpoints'], 'readwrite', async (tx) => {
      const store = tx.objectStore('checkpoints');
      const key = ['app', 'user', 'thread', '', '001'];
      const value = (await requestResult(store.get(key))) as Record<string, unknown>;
      value['v'] = 99;
      await requestResult(store.put(value));
    });
  } finally {
    db.close();
  }
  await expect(reopened.getTuple(config())).rejects.toEqual(new StorageError('corrupt'));
  await expect(entries(reopened)).rejects.toEqual(new StorageError('corrupt'));
});

it('serializes concurrent first puts atomically across connections', async () => {
  const name = `galaxie-concurrent-${crypto.randomUUID()}`;
  const first = await open(name);
  const second = await open(name);
  await Promise.all([
    save(first, config('z', 'b'), '001'),
    save(second, config('a', 'a'), '001'),
    save(second, config('z', 'a'), '002'),
  ]);
  const values = await entries(first);
  expect(values).toHaveLength(3);
  expect(await entries(second)).toEqual(values);
});

it('falls back only when the browser rejects transaction options', async () => {
  const saver = await open();
  const native = IDBDatabase.prototype.transaction;
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase['transaction']>
  ) {
    if (args[2] !== undefined) throw new TypeError('Unsupported options.');
    return native.apply(this, args);
  });
  await save(saver, config(), '001');
  expect((await saver.getTuple(config()))?.checkpoint.id).toBe('001');
});

it('maps quota and serialization failures without host text or partial data', async () => {
  const saver = await open();
  const native = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['put']>
  ) {
    if (this.name === 'checkpoints') throw new DOMException('private text', 'QuotaExceededError');
    return native.apply(this, args);
  });
  await expect(save(saver, config(), '001')).rejects.toEqual(new StorageError('quota'));
  spy.mockRestore();
  expect(await entries(saver)).toEqual([]);
  saver.serde.dumpsTyped = async () => {
    throw new Error('private text');
  };
  await expect(save(saver, config(), '001')).rejects.toEqual(new StorageError('unavailable'));
  expect(await entries(saver)).toEqual([]);
});

it.each([
  ['writes', 'checkpoint'],
  ['writes', 'thread'],
  ['checkpoints', 'thread'],
  ['checkpoints', 'namespace'],
] as const)('rejects a sparse %s.%s routing array on every read', async (storeName, field) => {
  const name = `galaxie-sparse-${crypto.randomUUID()}`;
  const saver = await open(name);
  const first = await save(saver, config(), '001');
  await save(saver, first, '002');
  await saver.putWrites(first, [['answer', 'from-001']], 'task');
  const db = await openDatabase(name, 'app', 'user');
  try {
    await transact(db, [storeName], 'readwrite', async (tx) => {
      const store = tx.objectStore(storeName);
      const key: IDBValidKey[] = ['app', 'user', 'thread', '', '001'];
      if (storeName === 'writes') key.push('task', 0);
      const value = (await requestResult(store.get(key))) as Record<string, unknown>;
      const routing = value[field];
      if (!Array.isArray(routing)) throw new Error('The fixture routing array is missing.');
      delete routing[routing.length - 1];
      await requestResult(store.put(value));
    });
  } finally {
    db.close();
  }
  await expect(saver.getTuple(first)).rejects.toEqual(new StorageError('corrupt'));
  await expect(entries(saver)).rejects.toEqual(new StorageError('corrupt'));
});
