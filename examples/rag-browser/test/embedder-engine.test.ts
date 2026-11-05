// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import { createEmbedder } from '../src/retrieval/embedder.js';
import { modelId, modelRevision } from '../src/retrieval/model-files.js';

const fake = vi.hoisted(() => {
  const config: Record<string, unknown> = { vision_config: {}, audio_config: {} };
  const env: Record<string, unknown> & { backends: { onnx: { wasm: Record<string, unknown> } } } = {
    backends: { onnx: { wasm: {} } },
  };
  const tokenizer = vi.fn(async (texts: string[]) => ({ texts }));
  const dispose = vi.fn(async () => {});
  const model = Object.assign(
    vi.fn(async ({ texts }: { texts: string[] }) => ({
      sentence_embedding: { tolist: () => texts.map(() => [3, 4, ...Array<number>(766).fill(0)]) },
    })),
    { dispose },
  );
  return { env, config, tokenizer, model, dispose, load: vi.fn(async () => model) };
});
vi.mock('@huggingface/transformers', () => ({
  env: fake.env,
  AutoConfig: { from_pretrained: async () => fake.config },
  AutoTokenizer: { from_pretrained: async () => fake.tokenizer },
  AutoModel: { from_pretrained: fake.load },
}));

test('wires a text-only q4 GPU engine to the verified cache, batches and normalizes', async () => {
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({}) } });
  if (typeof location === 'undefined')
    vi.stubGlobal('location', { href: 'https://host.example/worker' });
  const match = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('caches', { open: async () => ({ match }) });
  try {
    const embedder = await createEmbedder();
    expect(embedder.device).toBe('webgpu');
    expect(fake.load).toHaveBeenCalledWith(
      modelId,
      expect.objectContaining({
        revision: modelRevision,
        device: 'webgpu',
        dtype: 'q4',
        local_files_only: true,
      }),
    );
    expect(fake.config).toEqual({ vision_config: null, audio_config: null });
    const vectors = await embedder.embed(Array<string>(9).fill('moon'), 'query');
    expect(vectors).toHaveLength(9);
    expect(vectors[0]?.slice(0, 2)).toEqual([0.6, 0.8]);
    expect(vectors[0]).toHaveLength(256);
    expect(fake.tokenizer).toHaveBeenCalledTimes(2);
    expect(fake.tokenizer.mock.calls[0]?.[0]).toEqual(
      Array<string>(8).fill('task: search result | query: moon'),
    );
    expect(fake.env['allowRemoteModels']).toBe(false);
    expect(fake.env['useWasmCache']).toBe(false);
    const fetcher = fake.env['fetch'] as () => Promise<unknown>;
    await expect(fetcher()).rejects.toThrow('The verified model file is unavailable.');
    const cache = fake.env['customCache'] as { match(key: string): Promise<Response | undefined> };
    expect(await cache.match(`/verified-models/${modelId}/config.json`)).toBeInstanceOf(Response);
    expect(await cache.match('https://attacker.example/unknown')).toBeUndefined();
    await embedder.dispose();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
