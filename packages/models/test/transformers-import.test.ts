// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test, vi } from 'vitest';

const loaded = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('@huggingface/transformers', () => {
  loaded.names.push('@huggingface/transformers');
  return {};
});
vi.mock('onnxruntime-web', () => {
  loaded.names.push('onnxruntime-web');
  return {};
});

test('importing the Transformers.js entries loads no model library', async () => {
  const page = await import('../src/transformers/index.js');
  const worker = await import('../src/transformers/worker.js');
  expect(Object.keys(page).sort()).toEqual(['ModelError', 'checkTransformersModel']);
  expect(Object.keys(worker)).toEqual([]);
  expect(loaded.names).toEqual([]);
});
