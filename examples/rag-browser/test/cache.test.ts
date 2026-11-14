// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import { createNotifier, waitForState } from '../../../tests/conformance/support/state-wait.js';
import { fingerprint, IndexCache } from '../src/retrieval/cache.js';
import { RetrievalIndex } from '../src/retrieval/index.js';
import { createMockEmbedder } from '../src/retrieval/mock-embedder.js';

test('fingerprints distinguish corpus changes and mock vectors', async () => {
  expect(await fingerprint('a', true)).toBe(await fingerprint('a', true));
  expect(await fingerprint('a', true)).not.toBe(await fingerprint('b', true));
  expect(await fingerprint('a', true)).not.toBe(await fingerprint('a', false));
});

test('cache names encode both components without delimiter collisions', () => {
  const a = new IndexCache('app:team', 'user');
  const b = new IndexCache('app', 'team:user');
  try {
    expect(['app:team', 'user'].join(':')).toBe(['app', 'team:user'].join(':'));
    expect(a.name).toBe('galaxie-rag:app%3Ateam:user');
    expect(b.name).toBe('galaxie-rag:app:team%3Auser');
    expect(a.name).not.toBe(b.name);
  } finally {
    a.close();
    b.close();
  }
});

test.skipIf(typeof indexedDB === 'undefined').each(['principal', 'app'] as const)(
  'isolates records, epochs, clears, channels and stale writers by %s',
  async (different) => {
    const appId = `test-isolation-${crypto.randomUUID()}`;
    const a = new IndexCache(appId, 'first');
    const otherClear = vi.fn();
    const ownClear = vi.fn();
    const { notify, subscribe } = createNotifier();
    const b = new IndexCache(
      different === 'app' ? `${appId}-other` : appId,
      different === 'principal' ? 'second' : 'first',
      otherClear,
    );
    const peer = new IndexCache(appId, 'first', (epoch) => {
      ownClear(epoch);
      notify();
    });
    try {
      expect(a.name).not.toBe(b.name);
      const index = new RetrievalIndex(createMockEmbedder());
      const passage = {
        id: 'one',
        title: 'Pasted',
        text: 'Synthetic passage.',
        source: 'pasted' as const,
      };
      await index.add([passage]);
      const record = { fingerprint: 'scoped', saved: index.save(), pasted: [passage], count: 1 };
      const first = await a.load(record.fingerprint);
      const second = await b.load(record.fingerprint);
      expect(await a.save(first.epoch, record)).toBe(true);
      expect((await b.load(record.fingerprint)).record).toBeUndefined();
      expect(await b.save(second.epoch, record)).toBe(true);
      const cleared = await a.clear();
      await waitForState(subscribe, () => expect(ownClear).toHaveBeenCalledWith(cleared));
      expect(otherClear).not.toHaveBeenCalled();
      expect(await a.currentEpoch()).toBe(first.epoch + 1);
      expect(await b.currentEpoch()).toBe(second.epoch);
      expect((await a.load(record.fingerprint)).record).toBeUndefined();
      expect((await b.load(record.fingerprint)).record).toEqual(record);
      expect(await a.save(first.epoch, record)).toBe(false);
      expect(await b.save(second.epoch, record)).toBe(true);
    } finally {
      await a.clear();
      await b.clear();
      a.close();
      b.close();
      peer.close();
    }
  },
);

test.skipIf(typeof indexedDB === 'undefined')(
  'persists and clears content while fencing stale writes from another connection',
  async () => {
    const name = `test-cache-${crypto.randomUUID()}`;
    const a = new IndexCache(name, 'visitor');
    const b = new IndexCache(name, 'visitor');
    try {
      const index = new RetrievalIndex(createMockEmbedder());
      const old = {
        id: 'old',
        title: 'none',
        text: 'earlier private text',
        source: 'pasted' as const,
      };
      await index.add([old]);
      const start = await a.load('fingerprint');
      const record = { fingerprint: 'fingerprint', saved: index.save(), pasted: [old], count: 1 };
      expect(await a.save(start.epoch, record)).toBe(true);
      expect((await b.load('fingerprint')).record?.pasted).toEqual([old]);
      await a.clear();
      expect((await indexedDB.databases()).some(({ name: value }) => value === a.name)).toBe(false);
      expect(await b.save(start.epoch, record)).toBe(false);
      expect((await b.load('fingerprint')).record).toBeUndefined();
      const fresh = await b.load('fingerprint');
      expect(await b.save(fresh.epoch, record)).toBe(true);
      expect((await a.load('changed')).record).toBeUndefined();
      expect((await a.load('fingerprint')).record).toBeUndefined();
    } finally {
      await a.clear();
      a.close();
      b.close();
    }
  },
);

test.skipIf(typeof indexedDB === 'undefined')(
  'clearing also deletes the database an earlier build named by app only',
  async () => {
    const app = `test-legacy-${crypto.randomUUID()}`;
    const legacy = `galaxie-rag:${app}`;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(legacy, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('index');
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    expect((await indexedDB.databases()).some(({ name }) => name === legacy)).toBe(true);
    const cache = new IndexCache(app, 'visitor');
    try {
      await cache.clear();
      expect((await indexedDB.databases()).some(({ name }) => name === legacy)).toBe(false);
    } finally {
      cache.close();
    }
  },
);

test.skipIf(typeof indexedDB === 'undefined')(
  'clearing an app named epochs keeps the shared epoch database and its counters',
  async () => {
    const other = new IndexCache(`test-other-${crypto.randomUUID()}`, 'visitor');
    const epochs = new IndexCache('epochs', 'visitor');
    try {
      const first = await other.clear();
      await epochs.clear();
      expect(await other.currentEpoch()).toBe(first);
    } finally {
      await other.clear();
      other.close();
      await epochs.clear();
      epochs.close();
    }
  },
);
