// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import { sha256 } from '../src/corpus.js';
import { cacheModelFile, type ModelFile } from '../src/retrieval/model-files.js';

test('verifies before caching, reuses cache without fetch, and finishes progress', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const file: ModelFile = { path: 'config.json', bytes: 3, sha256: await sha256(bytes) };
  const records = new Map<string, Response>();
  const cache = {
    match: async (key: string) => records.get(key)?.clone(),
    put: async (key: string, value: Response) => {
      records.set(key, value);
    },
    delete: async (key: string) => records.delete(key),
  };
  const fetcher = vi.fn(async () => new Response(bytes));
  const progress: number[] = [];
  await cacheModelFile(file, cache, fetcher, (loaded) => progress.push(loaded));
  await cacheModelFile(file, cache, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(progress.at(-1)).toBe(3);
  records.clear();
  await expect(
    cacheModelFile(file, cache, async () => new Response(new Uint8Array([1, 2, 4]))),
  ).rejects.toThrow('The embedding model file failed verification.');
  expect(records.size).toBe(0);
  await expect(
    cacheModelFile(file, cache, async () => {
      throw new Error('private detail');
    }),
  ).rejects.toThrow('The embedding model download failed.');
});
