// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { modelCacheName, modelFiles, modelFileUrl, modelId, modelRevision } from './model-files.js';
import { embeddingSettings } from './settings.js';

export interface Embedder {
  readonly device: 'mock' | 'webgpu';
  embed(texts: readonly string[], kind: 'query' | 'passage'): Promise<number[][]>;
  dispose(): Promise<void>;
}
export const webgpuMessage: string = 'WebGPU is required to index text.';
export function requireWebGPU(): void {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu)
    throw new Error(webgpuMessage);
}
export async function verifyWebGPU(): Promise<void> {
  requireWebGPU();
  try {
    const gpu = (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!(await gpu.requestAdapter())) throw new Error();
  } catch {
    throw new Error(webgpuMessage);
  }
}
export function normalize(vector: readonly number[]): number[] {
  const cut = vector.slice(0, embeddingSettings.dimensions);
  const length = Math.hypot(...cut);
  if (!length || cut.some((v) => !Number.isFinite(v)))
    throw new Error('The embedding result is invalid.');
  return cut.map((v) => v / length);
}

export async function createEmbedder(): Promise<Embedder> {
  await verifyWebGPU();
  const { AutoConfig, AutoModel, AutoTokenizer, env } = await import('@huggingface/transformers');
  const [{ default: mjs }, { default: wasm }] = await Promise.all([
    import('onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'),
    import('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'),
  ]);
  const cache = await caches.open(modelCacheName);
  // hub.js checks the local key first, then the revision-pinned remote key.
  // Deny library fetches too: optional cache misses must never reach the network.
  env.fetch = async () => {
    throw new Error('The verified model file is unavailable.');
  };
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = '/verified-models/';
  env.remotePathTemplate = `{model}/resolve/${modelRevision}/`;
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.useCustomCache = true;
  env.useWasmCache = false;
  env.customCache = {
    async match(key) {
      const file = modelFiles.find(
        (file) => key === modelFileUrl(file) || key === `/verified-models/${modelId}/${file.path}`,
      );
      return file ? await cache.match(modelFileUrl(file)) : undefined;
    },
    async put() {
      throw new Error('The verified model cache is read-only.');
    },
  };
  if (!env.backends.onnx.wasm) throw new Error('The WebGPU embedding model could not be started.');
  Object.assign(env.backends.onnx.wasm, {
    wasmPaths: { mjs: new URL(mjs, location.href).href, wasm: new URL(wasm, location.href).href },
    numThreads: 1,
    proxy: false,
  });
  try {
    const config = await AutoConfig.from_pretrained(modelId, {
      revision: modelRevision,
      local_files_only: true,
    });
    Object.assign(config, { vision_config: null, audio_config: null });
    const tokenizer = await AutoTokenizer.from_pretrained(modelId, {
      revision: modelRevision,
      local_files_only: true,
    });
    const model = await AutoModel.from_pretrained(modelId, {
      config,
      revision: modelRevision,
      local_files_only: true,
      device: 'webgpu',
      dtype: 'q4',
    });
    return {
      device: 'webgpu',
      async embed(texts, kind) {
        const vectors: number[][] = [];
        for (let start = 0; start < texts.length; start += embeddingSettings.batchSize) {
          const batch = texts
            .slice(start, start + embeddingSettings.batchSize)
            .map((text) => (kind === 'query' ? `${embeddingSettings.queryPrefix}${text}` : text));
          const inputs = await tokenizer(batch, {
            padding: true,
            truncation: true,
            max_length: embeddingSettings.maxTokens,
          });
          const result = await model(inputs);
          for (const vector of result['sentence_embedding'].tolist() as number[][])
            vectors.push(normalize(vector));
        }
        return vectors;
      },
      async dispose() {
        await model.dispose();
      },
    };
  } catch {
    throw new Error('The WebGPU embedding model could not be started.');
  }
}
