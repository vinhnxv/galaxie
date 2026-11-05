// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// The pinned model files, and how the worker gets them: from Cache Storage when present, otherwise
// from huggingface.co, and in both cases checked against the size and hash the Hub lists.

const REPO = 'LiquidAI/LFM3-1.7B-ONNX';
const REVISION = '189271ef61b9e7fdd4a8b5b0891bcacad37700f8';
// The Cache Storage name of spikes/b0-webgpu-load. Both pages are served from
// http://127.0.0.1:4173, so the 1.4 GB the B0 page downloaded is reused here.
const CACHE_NAME = `b0-lfm3-1.7b-${REVISION.slice(0, 12)}`;

interface PinnedFile {
  readonly path: string;
  readonly size: number;
  /** For Git LFS files. */
  readonly sha256?: string;
  /** The git blob SHA-1, for files outside Git LFS. */
  readonly gitSha1?: string;
}

// Sizes and hashes from the Hub's file listing at REVISION.
export const FILES = {
  config: {
    path: 'config.json',
    size: 1_657,
    gitSha1: 'f2e21096218e68743764ae76d8f3ab56a300eaa5',
  },
  tokenizerConfig: {
    path: 'tokenizer_config.json',
    size: 14_574,
    gitSha1: 'fcba47091d2e196f5ce136f1c2705635b088d385',
  },
  chatTemplate: {
    path: 'chat_template.jinja',
    size: 12_129,
    gitSha1: 'd0747b8b5fc99eaecfe02a04eefcff75eb181334',
  },
  tokenizer: {
    path: 'tokenizer.json',
    size: 17_908_634,
    sha256: '41927bd314d17d7d7fadb44e10cd0919f7b71528d7741596d8cbd15c6945ec44',
  },
  graph: {
    path: 'onnx/model_q4f16.onnx',
    size: 268_082,
    sha256: '92cfb8854f0bb27e308f0f5b0106de9c4149505ad2e929b2676d6d89541884e5',
  },
  weights: {
    path: 'onnx/model_q4f16.onnx_data',
    size: 1_382_930_432,
    sha256: 'd8c39dc3ebeeaa00ad016d42112e97b7c6131cb255eb2755ea1d05d05ffa73dd',
  },
} as const satisfies Record<string, PinnedFile>;

export type ModelFile = keyof typeof FILES;

export const TOTAL_DOWNLOAD_BYTES: number = Object.values(FILES).reduce(
  (total, file) => total + file.size,
  0,
);

const urlOf = (file: PinnedFile): string =>
  `https://huggingface.co/${REPO}/resolve/${REVISION}/${file.path}`;

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

async function hashMatches(bytes: Uint8Array<ArrayBuffer>, file: PinnedFile): Promise<boolean> {
  if (file.sha256 !== undefined) {
    return toHex(await crypto.subtle.digest('SHA-256', bytes)) === file.sha256;
  }
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const blob = new Uint8Array(header.byteLength + bytes.byteLength);
  blob.set(header);
  blob.set(bytes, header.byteLength);
  return toHex(await crypto.subtle.digest('SHA-1', blob)) === file.gitSha1;
}

/** Whether the large weights file is already in Cache Storage, so loading needs no download. */
export async function weightsAreCached(): Promise<boolean> {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match(urlOf(FILES.weights))) !== undefined;
}

export interface LoadedFile {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly downloaded: boolean;
}

/**
 * Returns the file's bytes, downloading them into Cache Storage first if needed, after checking
 * them against the pinned size and hash. A file that fails the check is removed from the cache.
 */
export async function loadFile(
  name: ModelFile,
  onBytes: (loaded: number, total: number) => void,
): Promise<LoadedFile> {
  const file: PinnedFile = FILES[name];
  const url = urlOf(file);
  const cache = await caches.open(CACHE_NAME);
  let cached = await cache.match(url);
  const downloaded = cached === undefined;
  if (cached === undefined) {
    const response = await fetch(url);
    if (!response.ok || response.body === null) {
      throw new Error(`GET ${file.path}: HTTP ${response.status}`);
    }
    let received = 0;
    const counted = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          onBytes(received, file.size);
          controller.enqueue(chunk);
        },
      }),
    );
    await cache.put(url, new Response(counted));
    cached = await cache.match(url);
    if (cached === undefined) {
      throw new Error(`${file.path}: not in Cache Storage after the download`);
    }
  }
  const bytes = new Uint8Array(await cached.arrayBuffer());
  onBytes(bytes.byteLength, file.size);
  if (bytes.byteLength !== file.size || !(await hashMatches(bytes, file))) {
    await cache.delete(url);
    throw new Error(`${file.path}: size or hash does not match revision ${REVISION}`);
  }
  return { bytes, downloaded };
}
