// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { checkTransformersModel } from '../../packages/models/src/transformers/index.js';
import {
  loadVerifiedModelFiles,
  storedBytesHeader,
  storedSha256Header,
} from '../../packages/models/src/transformers/model-files.js';
import { modelCacheName } from '../../packages/models/src/transformers/model-record.js';
import {
  createFakeFetch,
  createSyntheticModel,
  MemoryCacheStorage,
  patternBytes,
  readBytes,
  type SyntheticModel,
} from '../../packages/models/test/support/transformers-model.js';

// Chromium runs on real Cache Storage; Node, which has none, runs on an in-memory stand-in.
const created: string[] = [];

beforeEach(() => {
  if (typeof caches === 'undefined') vi.stubGlobal('caches', new MemoryCacheStorage());
});

afterEach(async () => {
  for (const name of created.splice(0)) await caches.delete(name);
  vi.unstubAllGlobals();
});

async function model(): Promise<{
  readonly synthetic: SyntheticModel;
  readonly cache: Cache;
}> {
  const synthetic = await createSyntheticModel();
  const name = modelCacheName(synthetic.record);
  created.push(name);
  return { synthetic, cache: await caches.open(name) };
}

async function stored(cache: Cache): Promise<string[]> {
  return (await cache.keys()).map((request) => request.url).sort();
}

test('a download stores verified files and a later load finds them without a fetch', async () => {
  const { synthetic, cache } = await model();
  const { record, served, urls } = synthetic;
  expect(await checkTransformersModel({ model: record })).toEqual({
    status: 'downloadable',
    bytes: 12000,
    siteStorage: true,
  });
  const first = createFakeFetch(served);
  const progress: number[] = [];
  const loaded = await loadVerifiedModelFiles({
    record,
    store: cache,
    allowDownload: true,
    fetch: first.fetch,
    onProgress: (event) => progress.push(event.fraction),
  });
  expect(first.calls).toEqual(urls);
  expect(progress.at(-1)).toBe(1);
  expect(await stored(cache)).toEqual([...urls].sort());
  expect(await checkTransformersModel({ model: record })).toEqual({ status: 'available' });
  loaded.release();

  const second = createFakeFetch(served);
  const again = await loadVerifiedModelFiles({ record, store: cache, fetch: second.fetch });
  expect(second.calls).toEqual([]);
  for (const url of urls)
    expect(await readBytes(await again.cache.match(url))).toEqual(served.get(url));
});

test('a file altered in Cache Storage fails the next load, is deleted and is fetched again only on consent', async () => {
  const { synthetic, cache } = await model();
  const { record, served, urls } = synthetic;
  const url = urls[1] as string;
  (
    await loadVerifiedModelFiles({
      record,
      store: cache,
      allowDownload: true,
      fetch: createFakeFetch(served).fetch,
    })
  ).release();
  const original = served.get(url) as Uint8Array<ArrayBuffer>;
  const altered = original.slice();
  altered[5] = (altered[5] ?? 0) ^ 1;
  const markers = {
    [storedBytesHeader]: String(original.length),
    [storedSha256Header]: record.files[1]?.sha256 ?? '',
  };
  await cache.put(url, new Response(altered, { headers: markers }));
  const blocked = createFakeFetch(served);
  await expect(
    loadVerifiedModelFiles({ record, store: cache, fetch: blocked.fetch }),
  ).rejects.toMatchObject({ code: 'unavailable', reason: 'integrity' });
  expect(blocked.calls).toEqual([]);
  expect(await cache.match(url)).toBeUndefined();
  expect(await checkTransformersModel({ model: record })).toMatchObject({ status: 'downloadable' });

  const refetch = createFakeFetch(served);
  const restored = await loadVerifiedModelFiles({
    record,
    store: cache,
    allowDownload: true,
    fetch: refetch.fetch,
  });
  expect(refetch.calls).toEqual([url]);
  expect(await readBytes(await restored.cache.match(url))).toEqual(original);
});

test('an overlong body, a wrong hash and an abort leave no entry for the failing file', async () => {
  const { synthetic, cache } = await model();
  const { record, served, urls } = synthetic;
  const [first, second, third] = urls as [string, string, string];

  const longer = new Map(served);
  longer.set(second, new Uint8Array([...(served.get(second) ?? []), ...patternBytes(30000, 3)]));
  await expect(
    loadVerifiedModelFiles({
      record,
      store: cache,
      allowDownload: true,
      fetch: createFakeFetch(longer).fetch,
    }),
  ).rejects.toMatchObject({ code: 'unavailable', reason: 'integrity' });
  expect(await stored(cache)).toEqual([first]);

  const forged = new Map(served);
  const forgedBytes = (served.get(second) as Uint8Array<ArrayBuffer>).slice();
  forgedBytes[0] = (forgedBytes[0] ?? 0) ^ 1;
  forged.set(second, forgedBytes);
  await expect(
    loadVerifiedModelFiles({
      record,
      store: cache,
      allowDownload: true,
      fetch: createFakeFetch(forged).fetch,
    }),
  ).rejects.toMatchObject({ code: 'unavailable', reason: 'integrity' });
  expect(await stored(cache)).toEqual([first]);

  const controller = new AbortController();
  const stalled = createFakeFetch(served, { stall: { url: second, afterChunks: 2 } });
  const pending = loadVerifiedModelFiles({
    record,
    store: cache,
    allowDownload: true,
    fetch: stalled.fetch,
    signal: controller.signal,
  });
  while ((stalled.pulled.get(second) ?? 0) < 2)
    await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort(new Error('stop'));
  await expect(pending).rejects.toThrow('stop');
  expect(await stored(cache)).toEqual([first]);

  const resume = createFakeFetch(served);
  await loadVerifiedModelFiles({ record, store: cache, allowDownload: true, fetch: resume.fetch });
  expect(resume.calls).toEqual([second, third]);
  expect(await stored(cache)).toEqual([...urls].sort());
});
