// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { sha256 } from '../corpus.js';

export const modelId: string = 'onnx-community/embeddinggemma-2-ONNX';
export const modelRevision: string = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0';
export const modelCacheName: string = `galaxie-rag-model:${modelRevision}`;
export interface ModelFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface FileCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}
export const modelFiles: readonly ModelFile[] = [
  {
    path: 'config.json',
    bytes: 5031,
    sha256: '8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d',
  },
  {
    path: 'tokenizer.json',
    bytes: 32170510,
    sha256: '4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4',
  },
  {
    path: 'tokenizer_config.json',
    bytes: 1599,
    sha256: '17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874',
  },
  {
    path: 'onnx/model_q4.onnx',
    bytes: 490742,
    sha256: 'f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9',
  },
  {
    path: 'onnx/model_q4.onnx_data',
    bytes: 174028800,
    sha256: 'c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49',
  },
];
export const modelBytes: number = modelFiles.reduce((sum, file) => sum + file.bytes, 0);
export function modelFileUrl(file: ModelFile): string {
  return `https://huggingface.co/${modelId}/resolve/${modelRevision}/${file.path}`;
}
async function valid(response: Response, file: ModelFile): Promise<boolean> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.length === file.bytes && (await sha256(bytes)) === file.sha256;
}
export async function cacheModelFile(
  file: ModelFile,
  cache: FileCache,
  fetcher: typeof fetch = fetch,
  progress: (loaded: number) => void = () => {},
): Promise<Response> {
  const key = modelFileUrl(file);
  const cached = await cache.match(key);
  if (cached && (await valid(cached.clone(), file))) {
    progress(file.bytes);
    return cached;
  }
  await cache.delete(key);
  let response: Response;
  try {
    response = await fetcher(key, { credentials: 'omit', signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw new Error();
    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    let loaded = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      loaded += next.value.length;
      if (loaded > file.bytes) {
        await reader.cancel();
        throw new Error('size');
      }
      chunks.push(next.value);
      progress(loaded);
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    response = new Response(bytes);
  } catch {
    throw new Error('The embedding model download failed.');
  }
  if (!(await valid(response.clone(), file))) {
    await cache.delete(key);
    throw new Error('The embedding model file failed verification.');
  }
  await cache.put(key, response.clone());
  progress(file.bytes);
  return response;
}
export async function hasModelFiles(cache: FileCache): Promise<boolean> {
  for (const file of modelFiles) {
    const cached = await cache.match(modelFileUrl(file));
    if (!cached || !(await valid(cached, file))) {
      await cache.delete(modelFileUrl(file));
      return false;
    }
  }
  return true;
}
export async function downloadModelFiles(
  cache: FileCache,
  progress: (loaded: number, total: number) => void,
): Promise<void> {
  let completed = 0;
  for (const file of modelFiles) {
    await cacheModelFile(file, cache, fetch, (loaded) => progress(completed + loaded, modelBytes));
    completed += file.bytes;
  }
}
