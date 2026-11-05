// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { fingerprint, IndexCache } from '../src/retrieval/cache.js';
import { RetrievalIndex } from '../src/retrieval/index.js';
import { createMockEmbedder } from '../src/retrieval/mock-embedder.js';

test('fingerprints distinguish corpus changes and mock vectors', async () => {
  expect(await fingerprint('a', true)).toBe(await fingerprint('a', true));
  expect(await fingerprint('a', true)).not.toBe(await fingerprint('b', true));
  expect(await fingerprint('a', true)).not.toBe(await fingerprint('a', false));
});

test.skipIf(typeof indexedDB === 'undefined')(
  'persists and clears content while fencing stale writes from another connection',
  async () => {
    const name = `test-cache-${crypto.randomUUID()}`;
    const a = new IndexCache(name);
    const b = new IndexCache(name);
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
