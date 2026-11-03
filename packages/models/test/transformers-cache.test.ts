// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { checkTransformersModel } from '../src/transformers/index.js';
import { loadVerifiedModelFiles } from '../src/transformers/model-files.js';
import { modelCacheName, parseModelRecord } from '../src/transformers/model-record.js';
import {
  createFakeFetch,
  createSyntheticModel,
  MemoryCacheStorage,
  type MemoryStore,
} from './support/transformers-model.js';

let storage: MemoryCacheStorage;
let fetchCalls: number;
let digestCalls: number;

beforeEach(() => {
  storage = new MemoryCacheStorage();
  fetchCalls = 0;
  digestCalls = 0;
  vi.stubGlobal('caches', storage);
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubGlobal('fetch', async () => {
    fetchCalls += 1;
    return new Response(null, { status: 500 });
  });
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    digestCalls += 1;
    return digest(...args);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function storedModel(device: 'webgpu' | 'wasm' = 'webgpu') {
  const model = await createSyntheticModel();
  const record = parseModelRecord({ ...model.record, device });
  const store = (await storage.open(modelCacheName(record))) as MemoryStore;
  const network = createFakeFetch(model.served);
  await loadVerifiedModelFiles({ record, store, allowDownload: true, fetch: network.fetch });
  expect(digestCalls).toBeGreaterThan(0);
  digestCalls = 0;
  storage.opened.length = 0;
  return { model, record, store };
}

test('a WebGPU record without navigator.gpu is unavailable and never touches storage', async () => {
  const { record } = await storedModel();
  vi.stubGlobal('navigator', {});
  const has = vi.spyOn(storage, 'has');
  expect(await checkTransformersModel({ model: record })).toEqual({ status: 'unavailable' });
  expect(has).not.toHaveBeenCalled();
  expect(storage.opened).toEqual([]);
});

test('a WASM record ignores the WebGPU check', async () => {
  const { record } = await storedModel('wasm');
  vi.stubGlobal('navigator', {});
  expect(await checkTransformersModel({ model: record })).toEqual({ status: 'available' });
});

test('stored files with matching markers are available, without a fetch or a hash', async () => {
  const { record } = await storedModel();
  expect(await checkTransformersModel({ model: record })).toEqual({ status: 'available' });
  expect(fetchCalls).toBe(0);
  expect(digestCalls).toBe(0);
});

test('a model that was never stored is downloadable and its cache is not created', async () => {
  const model = await createSyntheticModel();
  expect(await checkTransformersModel({ model: model.record })).toEqual({
    status: 'downloadable',
    bytes: 12000,
    siteStorage: true,
  });
  expect(storage.opened).toEqual([]);
  expect(storage.stores.size).toBe(0);
});

test('a missing file, a size marker mismatch or a hash marker mismatch is downloadable with the summed size', async () => {
  const { record, store, model } = await storedModel();
  const [first, second, third] = model.urls as [string, string, string];
  const entry = store.entries.get(second);
  if (entry === undefined) throw new Error('missing entry');
  const expected = { status: 'downloadable', bytes: 12000, siteStorage: true };

  store.entries.delete(first);
  expect(await checkTransformersModel({ model: record })).toEqual(expected);
  store.entries.set(first, { bytes: new Uint8Array(1), headers: [] });
  expect(await checkTransformersModel({ model: record })).toEqual(expected);

  const sizeHeaders = entry.headers.map(([name, value]): [string, string] =>
    name === 'x-galaxie-bytes' ? [name, String(Number(value) + 1)] : [name, value],
  );
  store.entries.set(first, entry);
  store.entries.set(second, { ...entry, headers: sizeHeaders });
  expect(await checkTransformersModel({ model: record })).toEqual(expected);

  const hashHeaders = entry.headers.map(([name, value]): [string, string] =>
    name === 'x-galaxie-sha256' ? [name, '0'.repeat(64)] : [name, value],
  );
  store.entries.set(second, { ...entry, headers: hashHeaders });
  store.entries.delete(third);
  expect(await checkTransformersModel({ model: record })).toEqual(expected);
  expect(fetchCalls).toBe(0);
  expect(digestCalls).toBe(0);
});

test('missing Cache Storage or a storage failure is unavailable', async () => {
  const { record } = await storedModel();
  vi.stubGlobal('caches', undefined);
  expect(await checkTransformersModel({ model: record })).toEqual({ status: 'unavailable' });
  vi.stubGlobal('caches', {
    has: async () => {
      throw new DOMException('private storage text', 'SecurityError');
    },
  });
  expect(await checkTransformersModel({ model: record })).toEqual({ status: 'unavailable' });
});

test('an invalid record is rejected with a fixed invalid error', async () => {
  const { record } = await storedModel();
  const error: unknown = await checkTransformersModel({
    model: { ...record, revision: 'main' },
  }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ name: 'GalaxieError', code: 'invalid' });
  expect(fetchCalls).toBe(0);
});
