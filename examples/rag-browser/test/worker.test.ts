// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import { parseCorpus } from '../src/corpus.js';
import { RetrievalClient } from '../src/retrieval/client.js';
import { RetrievalIndex } from '../src/retrieval/index.js';
import type { RetrievalEvent } from '../src/retrieval/protocol.js';
import { RetrievalService } from '../src/retrieval/service.js';
import fixture from './fixtures/corpus.json' with { type: 'json' };

test('a terminal Worker failure rejects pending and future requests', async () => {
  const port = Object.assign(new EventTarget(), {
    postMessage: vi.fn(),
    terminate: vi.fn(),
  });
  const client = new RetrievalClient(port as unknown as Worker);
  try {
    const pending = client.init({ appId: 'failed-worker', mock: true, corpus: null });
    const rejected = expect(pending).rejects.toThrow('The retrieval Worker is unavailable.');
    port.dispatchEvent(new Event('error'));
    await rejected;
    await expect(
      client.search({ query: 'capital of France', mode: 'fulltext', k: 10 }),
    ).rejects.toThrow('The retrieval Worker is unavailable.');
    await expect(client.init({ appId: 'failed-worker', mock: true, corpus: null })).rejects.toThrow(
      'The retrieval Worker is unavailable.',
    );
    expect(port.postMessage).toHaveBeenCalledTimes(1);
  } finally {
    client.dispose();
  }
  expect(port.terminate).toHaveBeenCalledOnce();
});

test.skipIf(typeof indexedDB === 'undefined' || typeof Worker === 'undefined')(
  'a pending paste across another Worker clear cannot restore deleted text',
  async () => {
    const appId = `test-pending-clear-${crypto.randomUUID()}`;
    const corpus = parseCorpus(fixture);
    const events: RetrievalEvent[] = [];
    const service = new RetrievalService((event) => events.push(event));
    const peer = new RetrievalClient(
      new Worker(new URL('../src/retrieval/worker.ts', import.meta.url), { type: 'module' }),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const add = RetrievalIndex.prototype.add;
    const indexing = vi.spyOn(RetrievalIndex.prototype, 'add').mockImplementation(async function (
      this: RetrievalIndex,
      passages,
      progress,
    ) {
      if (passages.some(({ text }) => text === 'Violet archives hold secrets.')) {
        entered.resolve();
        await release.promise;
      }
      await add.call(this, passages, progress);
    });
    try {
      await service.handle({ id: 1, type: 'init', input: { appId, mock: true, corpus } });
      await service.handle({
        id: 2,
        type: 'paste',
        text: 'Cobalt observatories count seven comets.',
      });
      await peer.init({ appId, mock: true, corpus });
      const pending = service.handle({
        id: 3,
        type: 'paste',
        text: 'Violet archives hold secrets.',
      });
      await entered.promise;
      await peer.clear();
      release.resolve();
      await pending;
      expect(events.at(-1)).toMatchObject({
        type: 'failed',
        id: 3,
        message: 'The retrieval data was cleared. Please retry.',
      });
      await peer.init({ appId, mock: true, corpus });
      expect(peer.getSnapshot().pastedCount).toBe(0);
      for (const query of ['Cobalt observatories', 'Violet archives'])
        expect((await peer.search({ query, mode: 'fulltext', k: 10 })).passages).toEqual([]);
      await peer.clear();
    } finally {
      release.resolve();
      indexing.mockRestore();
      peer.dispose();
      await service.dispose();
    }
  },
  15000,
);

test.skipIf(typeof indexedDB === 'undefined')(
  'restores without embedding and drops incompatible fingerprints',
  async () => {
    const events: RetrievalEvent[] = [];
    const appId = `test-service-${crypto.randomUUID()}`;
    const corpus = parseCorpus(fixture);
    const first = new RetrievalService((event) => events.push(event));
    await first.handle({ id: 1, type: 'init', input: { appId, mock: true, corpus } });
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      result: { status: 'ready', count: 12, restored: false },
    });
    await first.handle({
      id: 2,
      type: 'paste',
      text: 'Cobalt observatories count seven comets.\n\nAmber libraries hold eleven books.',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      result: { status: 'ready', pastedCount: 2, added: 2 },
    });
    await first.dispose();
    const add = vi.spyOn(RetrievalIndex.prototype, 'add');
    const restoredEvents: RetrievalEvent[] = [];
    const restored = new RetrievalService((event) => restoredEvents.push(event));
    try {
      await restored.handle({ id: 1, type: 'init', input: { appId, mock: true, corpus } });
      expect(restoredEvents.at(-1)).toMatchObject({
        type: 'result',
        result: { status: 'ready', count: 14, pastedCount: 2, restored: true },
      });
      expect(add).not.toHaveBeenCalled();
      await restored.handle({
        id: 2,
        type: 'search',
        input: { query: 'Cobalt observatories', mode: 'fulltext', k: 10 },
      });
      expect(restoredEvents.at(-1)).toMatchObject({
        type: 'result',
        result: { passages: [{ title: 'Pasted text' }] },
      });
      await restored.handle({
        id: 3,
        type: 'init',
        input: { appId, mock: true, corpus: { ...corpus, passages: corpus.passages.slice(0, 2) } },
      });
      expect(restoredEvents.at(-1)).toMatchObject({
        type: 'result',
        result: { status: 'ready', count: 2, pastedCount: 0, restored: false },
      });
      expect(add).toHaveBeenCalledTimes(1);
      await restored.handle({ id: 4, type: 'clear' });
    } finally {
      add.mockRestore();
      await restored.dispose();
    }
  },
);

test.skipIf(typeof Worker === 'undefined')(
  'real Workers build, search, restore and fence cross-tab clearing',
  async () => {
    const appId = `test-workers-${crypto.randomUUID()}`;
    const corpus = parseCorpus(fixture);
    const makeClient = (): RetrievalClient =>
      new RetrievalClient(
        new Worker(new URL('../src/retrieval/worker.ts', import.meta.url), { type: 'module' }),
      );
    const a = makeClient();
    const b = makeClient();
    let reopened: RetrievalClient | undefined;
    try {
      await a.init({ appId, mock: true, corpus });
      await a.paste('Cobalt observatories count seven comets.');
      await b.init({ appId, mock: true, corpus });
      expect(b.getSnapshot().restored).toBe(true);
      await a.clear();
      // B must fence stale data even if the clear broadcast has not arrived yet.
      await b.paste('Amber libraries hold eleven books.');
      const old = await b.search({ query: 'Cobalt observatories', mode: 'fulltext', k: 10 });
      expect(old.passages).toEqual([]);
      const fresh = await b.search({ query: 'Amber libraries', mode: 'fulltext', k: 10 });
      expect(fresh.passages[0]?.text).toBe('Amber libraries hold eleven books.');
      reopened = makeClient();
      await reopened.init({ appId, mock: true, corpus });
      expect(reopened.getSnapshot()).toMatchObject({ restored: true, pastedCount: 1 });
      expect(
        (await reopened.search({ query: 'Cobalt observatories', mode: 'fulltext', k: 10 }))
          .passages,
      ).toEqual([]);
      await reopened.clear();
    } finally {
      a.dispose();
      b.dispose();
      reopened?.dispose();
    }
  },
  15000,
);

test.skipIf(typeof indexedDB === 'undefined')(
  'a failed embedder reports the fixed WebGPU message through the client',
  async () => {
    const events: RetrievalEvent[] = [];
    const service = new RetrievalService((event) => events.push(event));
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu');
    // Chromium may expose the property on its prototype; hide it using a proxy.
    const original = navigator;
    vi.stubGlobal(
      'navigator',
      new Proxy(original, {
        has(target, key) {
          return key === 'gpu' ? false : Reflect.has(target, key);
        },
        get(target, key) {
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
    try {
      await service.handle({
        id: 1,
        type: 'init',
        input: { appId: `test-gpu-${crypto.randomUUID()}`, mock: false, corpus: null },
      });
      await service.handle({ id: 2, type: 'consent' });
      expect(events.at(-1)).toMatchObject({
        type: 'failed',
        id: 2,
        message: 'WebGPU is required to index text.',
      });
      const handlers = new Map<string, (event: MessageEvent<unknown>) => void>();
      const port = {
        addEventListener(type: string, handler: (event: MessageEvent<unknown>) => void) {
          handlers.set(type, handler);
        },
        removeEventListener() {},
        terminate() {},
        postMessage(message: unknown) {
          void service
            .handle(message)
            .then(() =>
              handlers.get('message')?.({ data: events.at(-1) } as MessageEvent<unknown>),
            );
        },
      } as unknown as Worker;
      const client = new RetrievalClient(port);
      const pending = client.consent();
      await expect(pending).rejects.toThrow('WebGPU is required to index text.');
      client.dispose();
    } finally {
      vi.unstubAllGlobals();
      if (descriptor) Object.defineProperty(original, 'gpu', descriptor);
      await service.dispose();
    }
  },
);
