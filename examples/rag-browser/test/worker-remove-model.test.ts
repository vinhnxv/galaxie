// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type Corpus, sha256 } from '../src/corpus.js';
import { fingerprint, IndexCache } from '../src/retrieval/cache.js';
import type { RetrievalEvent } from '../src/retrieval/protocol.js';
import { RetrievalService } from '../src/retrieval/service.js';

const fake = vi.hoisted(() => ({
  files: true,
  download: vi.fn(async (): Promise<void> => {
    throw new Error('Unexpected download.');
  }),
  fetch: vi.fn(async () => {
    throw new Error('Unexpected network request.');
  }),
}));
vi.mock('../src/retrieval/model-files.js', async (original) => ({
  ...(await original<typeof import('../src/retrieval/model-files.js')>()),
  hasModelFiles: async () => fake.files,
  downloadModelFiles: fake.download,
}));
vi.mock('../src/retrieval/embedder.js', async (original) => ({
  ...(await original<typeof import('../src/retrieval/embedder.js')>()),
  createEmbedder: async () => {
    const { createMockEmbedder } = await import('../src/retrieval/mock-embedder.js');
    return createMockEmbedder();
  },
}));

const corpus: Corpus = {
  format: 'galaxie.rag-corpus/v1',
  license: 'CC0-1.0',
  attribution: 'Synthetic test corpus.',
  source: { url: '', sha256: '0'.repeat(64) },
  passages: [
    { id: 'one', title: 'Comets', text: 'Cobalt observatories count seven violet comets.' },
    { id: 'two', title: 'Stars', text: 'Amber observatories count three silver stars.' },
  ],
  questions: [],
};

describe.skipIf(typeof indexedDB === 'undefined')('model removal and cached index restore', () => {
  let events: RetrievalEvent[];
  let service: RetrievalService;
  let fresh: RetrievalService | undefined;
  let cache: IndexCache;
  let digest: string;
  let input: { appId: string; principalScope: string; mock: boolean; corpus: Corpus };

  beforeEach(async () => {
    fake.files = true;
    fake.download.mockReset();
    fake.download.mockRejectedValue(new Error('Unexpected download.'));
    fake.fetch.mockClear();
    vi.stubGlobal('fetch', fake.fetch);
    vi.stubGlobal('navigator', {
      locks: navigator.locks,
      gpu: { requestAdapter: async () => ({}) },
    });
    events = [];
    fresh = undefined;
    service = new RetrievalService((event) => events.push(event));
    input = {
      appId: `remove-model-${crypto.randomUUID()}`,
      principalScope: 'visitor',
      mock: false,
      corpus,
    };
    cache = new IndexCache(input.appId, input.principalScope);
    digest = await fingerprint(
      await sha256(new TextEncoder().encode(JSON.stringify(corpus))),
      false,
    );
    await service.handle({ id: 1, type: 'init', input });
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      result: { status: 'ready', restored: false, count: 2 },
    });
  });

  afterEach(async () => {
    try {
      await fresh?.dispose();
      await service.dispose();
      await cache.clear();
      cache.close();
      expect(fake.fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  async function removeModel(): Promise<void> {
    await service.handle({ id: 2, type: 'remove-model' });
    fake.files = false;
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      id: 2,
      result: { status: 'awaiting-consent', count: 0, pastedCount: 0, restored: false },
    });
    events.length = 0;
  }

  async function restoreWithoutFiles(): Promise<void> {
    await removeModel();
    await service.dispose();
    expect((await cache.load(digest)).record).toMatchObject({ count: 2 });
    fresh = new RetrievalService((event) => events.push(event));
    await fresh.handle({ id: 3, type: 'init', input });
  }

  test('removal drops the ready index and search fails until consent', async () => {
    await removeModel();
    await service.handle({
      id: 3,
      type: 'search',
      input: { query: 'comets', mode: 'hybrid', k: 2 },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'failed',
      id: 3,
      message: 'The index is not ready.',
      snapshot: { count: 0 },
    });
    expect(events.some((event) => event.type === 'ready')).toBe(false);
    expect(fake.download).not.toHaveBeenCalled();
  });

  test('paste after removal fails without changing the cached index', async () => {
    const built = await cache.load(digest);
    await removeModel();
    await service.handle({ id: 3, type: 'paste', text: 'A new passage must not be indexed.' });
    expect(events.at(-1)).toMatchObject({
      type: 'failed',
      id: 3,
      message: 'The index is not ready.',
      snapshot: { count: 0, pastedCount: 0 },
    });
    expect(await cache.load(digest)).toEqual(built);
    expect(fake.download).not.toHaveBeenCalled();
  });

  test('a fresh service leaves the cached index unused when model files are missing', async () => {
    await restoreWithoutFiles();
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      id: 3,
      result: { status: 'awaiting-consent', restored: false, count: 0 },
    });
    expect(events.some((event) => event.type === 'ready')).toBe(false);
    expect(fake.download).not.toHaveBeenCalled();
  });

  test('consent downloads the missing files and reuses the original cached index', async () => {
    const built = await cache.load(digest);
    await restoreWithoutFiles();
    expect(fake.download).not.toHaveBeenCalled();
    fake.download.mockImplementationOnce(async () => {
      fake.files = true;
    });
    await fresh?.handle({ id: 4, type: 'consent' });
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      id: 4,
      result: { status: 'ready', restored: true, count: 2 },
    });
    expect(fake.download).toHaveBeenCalledTimes(1);
    expect(await cache.load(digest)).toEqual(built);
    expect(
      events.some((event) => event.type === 'progress' && event.snapshot.status === 'building'),
    ).toBe(false);
  });

  test('removing the model twice succeeds and keeps awaiting consent', async () => {
    await removeModel();
    await service.handle({ id: 3, type: 'remove-model' });
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      id: 3,
      result: { status: 'awaiting-consent', count: 0, pastedCount: 0, restored: false },
    });
    expect(events.some((event) => event.type === 'ready')).toBe(false);
    expect(fake.download).not.toHaveBeenCalled();
  });
});
