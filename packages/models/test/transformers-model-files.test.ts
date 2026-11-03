// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  deniedFetch,
  loadVerifiedModelFiles,
  type ModelFilesProgress,
  storedBytesHeader,
  storedSha256Header,
} from '../src/transformers/model-files.js';
import { localModelKey } from '../src/transformers/model-record.js';
import {
  createFakeFetch,
  createSyntheticModel,
  MemoryStore,
  patternBytes,
  readBytes,
} from './support/transformers-model.js';

const unavailable = (reason: string): object => ({
  name: 'GalaxieError',
  code: 'unavailable',
  reason,
});

async function loaded(options: { allowDownload?: boolean; chunkSize?: number } = {}) {
  const model = await createSyntheticModel();
  const store = new MemoryStore();
  const network = createFakeFetch(model.served, { chunkSize: options.chunkSize ?? 1000 });
  const progress: ModelFilesProgress[] = [];
  const files = await loadVerifiedModelFiles({
    record: model.record,
    store,
    allowDownload: true,
    fetch: network.fetch,
    onProgress: (event) => progress.push(event),
  });
  return { model, store, network, progress, files };
}

describe('verified model files', () => {
  it('downloads, verifies and stores every file with monotonic progress ending at 1', async () => {
    const { model, store, network, progress, files } = await loaded();
    expect(network.calls).toEqual(model.urls);
    expect(network.inits.every((init) => init.credentials === 'omit')).toBe(true);
    for (const [index, file] of model.record.files.entries()) {
      const url = model.urls[index] as string;
      const entry = store.entries.get(url);
      expect(entry?.bytes).toEqual(model.served.get(url));
      const headers = new Map(entry?.headers);
      expect(headers.get(storedBytesHeader)).toBe(String(file.bytes));
      expect(headers.get(storedSha256Header)).toBe(file.sha256);
      expect(headers.get('content-length')).toBe(String(file.bytes));
      expect(await readBytes(await files.cache.match(url))).toEqual(model.served.get(url));
      expect(await readBytes(await files.cache.match(localModelKey(model.record, file)))).toEqual(
        model.served.get(url),
      );
    }
    const fractions = progress.map((event) => event.fraction);
    expect(
      fractions.every((value, index) => index === 0 || value >= (fractions[index - 1] ?? 0)),
    ).toBe(true);
    expect(fractions.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(progress.at(-1)).toEqual({ phase: 'verify', fraction: 1 });
    expect(progress.filter((event) => event.phase === 'download').length).toBeGreaterThan(2);
    expect(progress.filter((event) => event.fraction === 1)).toHaveLength(1);
  });

  it('finds the stored files on a later load and fetches nothing', async () => {
    const { model, store, files } = await loaded();
    files.release();
    const network = createFakeFetch(model.served);
    const again = await loadVerifiedModelFiles({
      record: model.record,
      store,
      fetch: network.fetch,
    });
    expect(network.calls).toEqual([]);
    expect(await readBytes(await again.cache.match(model.urls[0] as string))).toEqual(
      model.served.get(model.urls[0] as string),
    );
  });

  it('stops reading a body longer than the record and stores nothing for it', async () => {
    const model = await createSyntheticModel();
    const second = model.urls[1] as string;
    const longer = new Map(model.served);
    const real = model.served.get(second) as Uint8Array<ArrayBuffer>;
    longer.set(second, new Uint8Array([...real, ...patternBytes(40000, 9)]));
    const store = new MemoryStore();
    const network = createFakeFetch(longer);
    await expect(
      loadVerifiedModelFiles({
        record: model.record,
        store,
        allowDownload: true,
        fetch: network.fetch,
      }),
    ).rejects.toMatchObject(unavailable('integrity'));
    expect([...store.entries.keys()]).toEqual([model.urls[0]]);
    expect(network.pulled.get(second)).toBeLessThan(Math.ceil((real.length + 40000) / 1000));
    expect(network.calls).toEqual([model.urls[0], second]);
  });

  it('rejects a body shorter than the record', async () => {
    const model = await createSyntheticModel();
    const shorter = new Map(model.served);
    const first = model.urls[0] as string;
    shorter.set(first, (model.served.get(first) as Uint8Array<ArrayBuffer>).slice(0, 2000));
    const store = new MemoryStore();
    await expect(
      loadVerifiedModelFiles({
        record: model.record,
        store,
        allowDownload: true,
        fetch: createFakeFetch(shorter).fetch,
      }),
    ).rejects.toMatchObject(unavailable('integrity'));
    expect(store.entries.size).toBe(0);
  });

  it('rejects, deletes and reports integrity for a body with the right size and a wrong hash', async () => {
    const model = await createSyntheticModel();
    const first = model.urls[0] as string;
    const forged = new Map(model.served);
    const forgedBytes = (model.served.get(first) as Uint8Array<ArrayBuffer>).slice();
    forgedBytes[7] = (forgedBytes[7] ?? 0) ^ 1;
    forged.set(first, forgedBytes);
    const store = new MemoryStore();
    store.entries.set(first, { bytes: new Uint8Array([1, 2, 3]), headers: [] });
    await expect(
      loadVerifiedModelFiles({
        record: model.record,
        store,
        allowDownload: true,
        fetch: createFakeFetch(forged).fetch,
      }),
    ).rejects.toMatchObject(unavailable('integrity'));
    expect(store.entries.size).toBe(0);
  });

  it('deletes a stored file altered after storing and fetches nothing without consent', async () => {
    const { model, store, files } = await loaded();
    files.release();
    const second = model.urls[1] as string;
    const entry = store.entries.get(second);
    if (entry === undefined) throw new Error('missing entry');
    const altered = entry.bytes.slice();
    altered[3] = (altered[3] ?? 0) ^ 1;
    store.entries.set(second, { ...entry, bytes: altered });
    const network = createFakeFetch(model.served);
    await expect(
      loadVerifiedModelFiles({ record: model.record, store, fetch: network.fetch }),
    ).rejects.toMatchObject(unavailable('integrity'));
    expect(network.calls).toEqual([]);
    expect(store.entries.has(second)).toBe(false);
    expect(store.entries.has(model.urls[0] as string)).toBe(true);
  });

  it('treats a stored file with a different size or no markers as missing', async () => {
    const { model, store, files } = await loaded();
    files.release();
    const first = model.urls[0] as string;
    const second = model.urls[1] as string;
    const firstEntry = store.entries.get(first);
    const secondEntry = store.entries.get(second);
    if (firstEntry === undefined || secondEntry === undefined) throw new Error('missing entry');
    store.entries.set(first, { ...firstEntry, bytes: firstEntry.bytes.slice(0, 10) });
    store.entries.set(second, { bytes: secondEntry.bytes, headers: [] });
    for (const url of [first, second]) {
      const network = createFakeFetch(model.served);
      await expect(
        loadVerifiedModelFiles({ record: model.record, store, fetch: network.fetch }),
      ).rejects.toMatchObject(unavailable('integrity'));
      expect(network.calls).toEqual([]);
      expect(store.entries.has(url)).toBe(false);
      await store.put(
        url,
        new Response(model.served.get(url), {
          headers: {
            [storedBytesHeader]: String(model.served.get(url)?.length),
            [storedSha256Header]: model.record.files[model.urls.indexOf(url)]?.sha256 ?? '',
          },
        }),
      );
    }
  });

  it('replaces an altered stored file when downloading is allowed', async () => {
    const { model, store, files } = await loaded();
    files.release();
    const second = model.urls[1] as string;
    const entry = store.entries.get(second);
    if (entry === undefined) throw new Error('missing entry');
    store.entries.set(second, { ...entry, bytes: patternBytes(entry.bytes.length, 77) });
    const network = createFakeFetch(model.served);
    const again = await loadVerifiedModelFiles({
      record: model.record,
      store,
      allowDownload: true,
      fetch: network.fetch,
    });
    expect(network.calls).toEqual([second]);
    expect(await readBytes(await again.cache.match(second))).toEqual(model.served.get(second));
    expect(store.entries.get(second)?.bytes).toEqual(model.served.get(second));
  });

  it('serves the bytes hashed during the load even if the store entry changes afterwards', async () => {
    const { model, store, files } = await loaded();
    const url = model.urls[1] as string;
    const original = model.served.get(url);
    store.entries.set(url, { bytes: patternBytes(10, 5), headers: [] });
    expect(await readBytes(await files.cache.match(url))).toEqual(original);
    const served = await readBytes(await files.cache.match(url));
    served.fill(0);
    expect(await readBytes(await files.cache.match(url))).toEqual(original);
  });

  it('leaves no entry after an abort mid-file and resumes with only the missing files', async () => {
    const model = await createSyntheticModel();
    const second = model.urls[1] as string;
    const store = new MemoryStore();
    const controller = new AbortController();
    const reason = new Error('stop');
    const stalled = createFakeFetch(model.served, { stall: { url: second, afterChunks: 2 } });
    const pending = loadVerifiedModelFiles({
      record: model.record,
      store,
      allowDownload: true,
      fetch: stalled.fetch,
      signal: controller.signal,
    });
    while ((stalled.pulled.get(second) ?? 0) < 2)
      await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect([...store.entries.keys()]).toEqual([model.urls[0]]);
    const resumed = createFakeFetch(model.served);
    await loadVerifiedModelFiles({
      record: model.record,
      store,
      allowDownload: true,
      fetch: resumed.fetch,
    });
    expect(resumed.calls).toEqual([second, model.urls[2]]);
    expect(store.entries.size).toBe(3);
  });

  it('rejects with the signal reason before fetching when it is already aborted', async () => {
    const model = await createSyntheticModel();
    const network = createFakeFetch(model.served);
    const reason = new Error('already stopped');
    await expect(
      loadVerifiedModelFiles({
        record: model.record,
        store: new MemoryStore(),
        allowDownload: true,
        fetch: network.fetch,
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(network.calls).toEqual([]);
  });

  it('gives the runtime a read-only cache and a fetch that always fails', async () => {
    const { model, files } = await loaded();
    await expect(files.cache.put()).rejects.toThrow('The verified model cache is read-only.');
    expect(await files.cache.match('https://models.example.test/other/file.json')).toBeUndefined();
    expect(await files.cache.match('/verified-models/other/config.json')).toBeUndefined();
    expect(
      await files.cache.match(model.urls[0]?.replace('resolve', 'blob') as string),
    ).toBeUndefined();
    await expect(deniedFetch()).rejects.toThrow('The verified model file is unavailable.');
    files.release();
    expect(await files.cache.match(model.urls[0] as string)).toBeUndefined();
  });

  it('fails with a download error for an HTTP error, a network error and a stalled transfer', async () => {
    const model = await createSyntheticModel();
    const first = model.urls[0] as string;
    const cases = [
      createFakeFetch(model.served, { status: { url: first, code: 503 } }).fetch,
      (async () => {
        throw new TypeError('private network text');
      }) as typeof fetch,
      createFakeFetch(model.served, { stall: { url: first, afterChunks: 1 } }).fetch,
    ];
    for (const [index, fetch] of cases.entries()) {
      const error: unknown = await loadVerifiedModelFiles({
        record: model.record,
        store: new MemoryStore(),
        allowDownload: true,
        fetch,
        idleTimeoutMs: index === 2 ? 30 : 60_000,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject(unavailable('download_failed'));
      expect(JSON.stringify(error)).not.toContain('private network text');
    }
  });

  it('checks the record itself before touching the store or the network', async () => {
    const model = await createSyntheticModel();
    const network = createFakeFetch(model.served);
    const bad = {
      ...model.record,
      files: [{ path: '../escape', bytes: 1, sha256: '0'.repeat(64) }],
    };
    await expect(
      loadVerifiedModelFiles({
        record: bad as typeof model.record,
        store: new MemoryStore(),
        allowDownload: true,
        fetch: network.fetch,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(network.calls).toEqual([]);
  });

  it('keeps a stored file when the store fails to read it and reports a load failure', async () => {
    const { model, store, files } = await loaded();
    files.release();
    const deleted: string[] = [];
    const url = model.urls[0] as string;
    const failing = {
      async match(key: string): Promise<Response | undefined> {
        if (key === url) throw new DOMException('private storage text', 'UnknownError');
        return store.match(key);
      },
      put: store.put.bind(store),
      async delete(key: string): Promise<boolean> {
        deleted.push(key);
        return store.delete(key);
      },
    };
    const network = createFakeFetch(model.served);
    const error: unknown = await loadVerifiedModelFiles({
      record: model.record,
      store: failing,
      allowDownload: true,
      fetch: network.fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject(unavailable('load_failed'));
    expect(JSON.stringify(error)).not.toContain('private storage text');
    expect(deleted).toEqual([]);
    expect(network.calls).toEqual([]);
    expect(store.entries.has(url)).toBe(true);
  });

  it('keeps a stored file whose body stream fails and reports a load failure', async () => {
    const { model, store, files } = await loaded();
    files.release();
    const url = model.urls[0] as string;
    const entry = store.entries.get(url);
    if (entry === undefined) throw new Error('missing entry');
    const broken = {
      async match(key: string): Promise<Response | undefined> {
        if (key !== url) return store.match(key);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new TypeError('stream failed'));
          },
        });
        return new Response(body, { headers: entry.headers });
      },
      put: store.put.bind(store),
      delete: store.delete.bind(store),
    };
    await expect(
      loadVerifiedModelFiles({
        record: model.record,
        store: broken,
        fetch: createFakeFetch(model.served).fetch,
      }),
    ).rejects.toMatchObject(unavailable('load_failed'));
    expect(store.entries.has(url)).toBe(true);
  });

  it('reports a download error when the body stream fails mid-file', async () => {
    const model = await createSyntheticModel();
    const first = model.urls[0] as string;
    const fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== first) return new Response(model.served.get(url));
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) controller.error(new TypeError('private network text'));
            else controller.enqueue(new Uint8Array(100));
            sent = true;
          },
        }),
      );
    }) as typeof globalThis.fetch;
    const store = new MemoryStore();
    const error: unknown = await loadVerifiedModelFiles({
      record: model.record,
      store,
      allowDownload: true,
      fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject(unavailable('download_failed'));
    expect(JSON.stringify(error)).not.toContain('private network text');
    expect(store.entries.size).toBe(0);
  });

  it('honors an abort that arrives while the last file is being stored', async () => {
    const model = await createSyntheticModel();
    const store = new MemoryStore();
    const controller = new AbortController();
    const reason = new Error('late stop');
    const put = store.put.bind(store);
    let puts = 0;
    store.put = async (key, response) => {
      await put(key, response);
      puts += 1;
      if (puts === model.urls.length) controller.abort(reason);
    };
    await expect(
      loadVerifiedModelFiles({
        record: model.record,
        store,
        allowDownload: true,
        fetch: createFakeFetch(model.served).fetch,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it('fails with a download error and leaves nothing behind when the store cannot save', async () => {
    const model = await createSyntheticModel();
    const store = new MemoryStore();
    store.failPut = true;
    await expect(
      loadVerifiedModelFiles({
        record: model.record,
        store,
        allowDownload: true,
        fetch: createFakeFetch(model.served).fetch,
      }),
    ).rejects.toMatchObject(unavailable('download_failed'));
    expect(store.entries.size).toBe(0);
  });

  it('never fetches without consent, even for an empty store', async () => {
    const model = await createSyntheticModel();
    const network = createFakeFetch(model.served);
    await expect(
      loadVerifiedModelFiles({
        record: model.record,
        store: new MemoryStore(),
        fetch: network.fetch,
      }),
    ).rejects.toMatchObject(unavailable('integrity'));
    await expect(
      loadVerifiedModelFiles({
        record: model.record,
        store: new MemoryStore(),
        allowDownload: false,
        fetch: network.fetch,
      }),
    ).rejects.toMatchObject(unavailable('integrity'));
    expect(network.calls).toEqual([]);
  });
});
