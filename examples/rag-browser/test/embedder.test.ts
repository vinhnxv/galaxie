// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import { createEmbedder, normalize } from '../src/retrieval/embedder.js';
import { createMockEmbedder } from '../src/retrieval/mock-embedder.js';

test('mock vectors are deterministic, unit length and rank shared words higher', async () => {
  const embedder = createMockEmbedder();
  const [query, relevant, unrelated] = await embedder.embed(
    ['capital of France', 'Paris is the capital of France', 'ducks swim'],
    'query',
  );
  expect(query).toEqual((await embedder.embed(['capital of France'], 'query'))[0]);
  expect(query).toHaveLength(256);
  expect(Math.hypot(...(query ?? []))).toBeCloseTo(1, 6);
  const dot = (a: number[], b: number[]): number => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
  expect(dot(query ?? [], relevant ?? [])).toBeGreaterThan(dot(query ?? [], unrelated ?? []));
  expect(Math.hypot(...normalize(Array.from({ length: 768 }, (_, i) => i + 1)))).toBeCloseTo(1, 6);
});

test('a real embedder without WebGPU fails before loading any library or WASM', async () => {
  vi.stubGlobal('navigator', {});
  try {
    await expect(createEmbedder()).rejects.toThrow('WebGPU is required to index text.');
  } finally {
    vi.unstubAllGlobals();
  }
});
