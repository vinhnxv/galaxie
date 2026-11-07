// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type InvalidationWatcher, watchInvalidation } from '@galaxie/core/browser';
import { afterEach, expect, test, vi } from 'vitest';
import { IndexCache } from '../src/retrieval/cache.js';
import { RetrievalClient } from '../src/retrieval/client.js';
import { emptySnapshot, type InitInput, type RetrievalEvent } from '../src/retrieval/protocol.js';
import { RetrievalService } from '../src/retrieval/service.js';

const services: RetrievalService[] = [];
const caches: IndexCache[] = [];
const watchers: InvalidationWatcher[] = [];
afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.close();
  for (const service of services.splice(0)) await service.dispose();
  for (const cache of caches.splice(0)) {
    await cache.clear();
    cache.close();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function watch(appId: string, principalScope: string): InvalidationWatcher {
  const watcher = watchInvalidation({ appId, principalScope });
  watchers.push(watcher);
  return watcher;
}

async function fixture(appId: string, principalScope = 'visitor') {
  const input: InitInput = { appId, principalScope, mock: true, corpus: null };
  const events: RetrievalEvent[] = [];
  const service = new RetrievalService((event) => events.push(event));
  services.push(service);
  const cache = new IndexCache(appId, principalScope);
  caches.push(cache);
  await service.handle({ id: 1, type: 'init', input });
  expect(events.at(-1)).toMatchObject({ type: 'result', result: { status: 'ready' } });
  return { input, service, events, cache };
}

test.skipIf(typeof indexedDB === 'undefined')(
  'matching principal invalidation wipes persisted and in-memory data in every service and can repeat',
  async () => {
    const appId = `test-invalidation-${crypto.randomUUID()}`;
    const first = await fixture(appId);
    await first.service.handle({
      id: 2,
      type: 'paste',
      text: 'Cobalt observatories count seven comets.',
    });
    const peer = await fixture(appId);
    expect(peer.events.at(-1)).toMatchObject({
      type: 'result',
      result: { restored: true, count: 1, pastedCount: 1 },
    });
    const announcer = watch(appId, 'visitor');
    const epoch = await first.cache.currentEpoch();
    announcer.announce();
    await vi.waitFor(async () => expect(await first.cache.currentEpoch()).toBe(epoch + 2));
    for (const events of [first.events, peer.events])
      await vi.waitFor(() =>
        expect(events.at(-1)).toEqual({
          type: 'progress',
          snapshot: { ...emptySnapshot, corpusMissing: true },
        }),
      );
    expect(
      (await indexedDB.databases()).some((database) => database.name === first.cache.name),
    ).toBe(false);
    await first.service.handle({
      id: 3,
      type: 'search',
      input: { query: 'Cobalt', mode: 'fulltext', k: 10 },
    });
    expect(first.events.at(-1)).toMatchObject({ type: 'result', result: { passages: [] } });
    await first.service.handle({
      id: 4,
      type: 'paste',
      text: 'Amber libraries hold eleven books.',
    });
    expect(first.events.at(-1)).toMatchObject({
      type: 'result',
      result: { status: 'ready', count: 1, pastedCount: 1 },
    });
    announcer.announce();
    await vi.waitFor(async () => expect(await first.cache.currentEpoch()).toBe(epoch + 4));
    await vi.waitFor(() =>
      expect(first.events.at(-1)).toEqual({
        type: 'progress',
        snapshot: { ...emptySnapshot, corpusMissing: true },
      }),
    );
    await first.service.handle({
      id: 5,
      type: 'search',
      input: { query: 'Amber', mode: 'fulltext', k: 10 },
    });
    expect(first.events.at(-1)).toMatchObject({ type: 'result', result: { passages: [] } });
  },
);

test.skipIf(typeof indexedDB === 'undefined')(
  'a failed stored wipe still drops in-memory data, reports failure and retries on the next notice',
  async () => {
    const appId = `test-invalidation-${crypto.randomUUID()}`;
    const { service, events, cache } = await fixture(appId);
    await service.handle({
      id: 2,
      type: 'paste',
      text: 'Cobalt observatories count seven comets.',
    });
    const announcer = watch(appId, 'visitor');
    const epoch = await cache.currentEpoch();
    const failing = vi
      .spyOn(IndexCache.prototype, 'clear')
      .mockRejectedValueOnce(new Error('The retrieval cache is unavailable.'));
    announcer.announce();
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        type: 'progress',
        snapshot: { status: 'failed', message: 'The retrieval cache is unavailable.' },
      }),
    );
    announcer.announce();
    await vi.waitFor(async () => expect(await cache.currentEpoch()).toBe(epoch + 1));
    await vi.waitFor(() =>
      expect(events.at(-1)).toEqual({
        type: 'progress',
        snapshot: { ...emptySnapshot, corpusMissing: true },
      }),
    );
    await service.handle({
      id: 3,
      type: 'search',
      input: { query: 'Cobalt', mode: 'fulltext', k: 10 },
    });
    expect(events.at(-1)).toMatchObject({ type: 'result', result: { passages: [] } });
  },
);

test.skipIf(typeof indexedDB === 'undefined').each(['principal', 'app'] as const)(
  'ignores invalidation for a different %s',
  async (different) => {
    const appId = `test-ignore-${crypto.randomUUID()}`;
    const first = await fixture(appId);
    await first.service.handle({
      id: 2,
      type: 'paste',
      text: 'Cobalt observatories count seven comets.',
    });
    const otherApp = different === 'app' ? `${appId}-other` : appId;
    const otherPrincipal = different === 'principal' ? 'other' : 'visitor';
    const announcer = watch(otherApp, otherPrincipal);
    const delivery = watch(otherApp, otherPrincipal);
    const before = first.events.length;
    announcer.announce();
    await vi.waitFor(() => expect(delivery.signal.aborted).toBe(true));
    expect(first.events).toHaveLength(before);
    await first.service.handle({
      id: 3,
      type: 'search',
      input: { query: 'Cobalt', mode: 'fulltext', k: 10 },
    });
    expect(first.events.at(-1)).toMatchObject({
      type: 'result',
      result: { passages: [{ text: 'Cobalt observatories count seven comets.' }] },
    });
  },
);

test.skipIf(typeof indexedDB === 'undefined')(
  'reload restores the same principal while another principal or app starts empty',
  async () => {
    const appId = `test-reload-${crypto.randomUUID()}`;
    const first = await fixture(appId);
    await first.service.handle({
      id: 2,
      type: 'paste',
      text: 'Cobalt observatories count seven comets.',
    });
    await first.service.dispose();
    const restored = await fixture(appId);
    expect(restored.events.at(-1)).toMatchObject({
      type: 'result',
      result: { restored: true, count: 1, pastedCount: 1 },
    });
    for (const other of [await fixture(appId, 'other'), await fixture(`${appId}-other`)])
      expect(other.events.at(-1)).toMatchObject({
        type: 'result',
        result: { restored: false, count: 0, pastedCount: 0 },
      });
  },
);

test.skipIf(typeof indexedDB === 'undefined')(
  'closes the watcher on reinitialization and disposal',
  async () => {
    const NativeChannel = BroadcastChannel;
    const channels: BroadcastChannel[] = [];
    vi.stubGlobal(
      'BroadcastChannel',
      class extends NativeChannel {
        constructor(name: string) {
          super(name);
          channels.push(this);
        }
      },
    );
    const appId = `test-close-${crypto.randomUUID()}`;
    const first = await fixture(appId);
    const old = channels.find((channel) => channel.name === `galaxie:${appId}:invalidation`);
    if (!old) throw new Error('The invalidation watcher was not opened.');
    const closeOld = vi.spyOn(old, 'close');
    await first.service.handle({
      id: 2,
      type: 'init',
      input: { ...first.input, principalScope: 'other' },
    });
    caches.push(new IndexCache(appId, 'other'));
    expect(closeOld).toHaveBeenCalledOnce();
    expect(old.onmessage).toBeNull();
    const current = channels.findLast((channel) => channel.name === old.name);
    if (!current) throw new Error('The replacement watcher was not opened.');
    expect(current).not.toBe(old);
    const beforeOldNotice = first.events.length;
    const oldDelivery = watch(appId, 'visitor');
    watch(appId, 'visitor').announce();
    await vi.waitFor(() => expect(oldDelivery.signal.aborted).toBe(true));
    expect(first.events).toHaveLength(beforeOldNotice);
    const closeCurrent = vi.spyOn(current, 'close');
    await first.service.dispose();
    expect(closeCurrent).toHaveBeenCalledOnce();
    expect(current.onmessage).toBeNull();
    const before = first.events.length;
    const delivery = watch(appId, 'other');
    watch(appId, 'other').announce();
    await vi.waitFor(() => expect(delivery.signal.aborted).toBe(true));
    expect(first.events).toHaveLength(before);
  },
);

test('missing BroadcastChannel reports the fixed cache-unavailable failure', async () => {
  const events: RetrievalEvent[] = [];
  const service = new RetrievalService((event) => events.push(event));
  services.push(service);
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('navigator', { locks: {} });
  await service.handle({
    id: 1,
    type: 'init',
    input: { appId: 'unsupported-cache', principalScope: 'visitor', mock: true },
  });
  expect(events.at(-1)).toMatchObject({
    type: 'failed',
    message: 'The retrieval cache is unavailable.',
  });
});

test.skipIf(typeof indexedDB === 'undefined' || typeof Worker === 'undefined')(
  'the retrieval Worker receives principal invalidation directly',
  async () => {
    const appId = `test-worker-invalidation-${crypto.randomUUID()}`;
    const client = new RetrievalClient(
      new Worker(new URL('../src/retrieval/worker.ts', import.meta.url), { type: 'module' }),
    );
    caches.push(new IndexCache(appId, 'visitor'));
    try {
      await client.init({ appId, principalScope: 'visitor', mock: true, corpus: null });
      await client.paste('Cobalt observatories count seven comets.');
      watch(appId, 'visitor').announce();
      await vi.waitFor(() =>
        expect(client.getSnapshot()).toEqual({ ...emptySnapshot, corpusMissing: true }),
      );
      expect((await client.search({ query: 'Cobalt', mode: 'fulltext', k: 10 })).passages).toEqual(
        [],
      );
    } finally {
      client.dispose();
    }
  },
);
