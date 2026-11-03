// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModelFileStore } from '../../src/transformers/model-files.js';
import {
  modelFileUrl,
  parseModelRecord,
  type TransformersModelRecord,
} from '../../src/transformers/model-record.js';

export const revision = '0123456789abcdef0123456789abcdef01234567';

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Deterministic bytes that differ per seed, so a swapped file never hashes the same. */
export function patternBytes(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + seed * 17) & 255;
  return bytes;
}

export interface SyntheticModel {
  readonly record: TransformersModelRecord;
  /** The bytes each record file URL serves, in record order. */
  readonly served: Map<string, Uint8Array<ArrayBuffer>>;
  readonly urls: readonly string[];
}

export async function createSyntheticModel(
  options: {
    readonly baseUrl?: string;
    readonly sizes?: readonly number[];
    readonly modelId?: string;
  } = {},
): Promise<SyntheticModel> {
  const modelId = options.modelId ?? `example-org/tiny-${crypto.randomUUID().slice(0, 8)}`;
  const baseUrl = options.baseUrl ?? `https://models.example.test/${modelId}/resolve/${revision}/`;
  const paths = ['config.json', 'tokenizer.json', 'tokenizer_config.json'];
  const sizes = options.sizes ?? [2500, 6000, 3500];
  const contents = paths.map((_, index) => patternBytes(sizes[index] ?? 1000, index + 1));
  const files = await Promise.all(
    paths.map(async (path, index) => {
      const bytes = contents[index] as Uint8Array<ArrayBuffer>;
      return { path, bytes: bytes.length, sha256: await sha256Hex(bytes) };
    }),
  );
  const record = parseModelRecord({
    modelId,
    baseUrl,
    revision,
    device: 'wasm',
    dtype: 'q4',
    contextWindow: 2048,
    files,
  });
  const served = new Map<string, Uint8Array<ArrayBuffer>>();
  record.files.forEach((file, index) => {
    served.set(modelFileUrl(record, file), contents[index] as Uint8Array<ArrayBuffer>);
  });
  return { record, served, urls: [...served.keys()] };
}

export interface FakeFetch {
  readonly fetch: typeof fetch;
  readonly calls: string[];
  readonly inits: RequestInit[];
  /** Chunks handed to the reader, per URL. */
  readonly pulled: Map<string, number>;
}

export interface FakeFetchOptions {
  readonly chunkSize?: number;
  /** The named URL emits this many chunks, then waits until the request is aborted. */
  readonly stall?: { readonly url: string; readonly afterChunks: number };
  /** The named URL answers with this status instead of its bytes. */
  readonly status?: { readonly url: string; readonly code: number };
}

export function createFakeFetch(
  served: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
  options: FakeFetchOptions = {},
): FakeFetch {
  const chunkSize = options.chunkSize ?? 1000;
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  const pulled = new Map<string, number>();
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    inits.push(init ?? {});
    if (options.status?.url === url) return new Response(null, { status: options.status.code });
    const bytes = served.get(url);
    if (bytes === undefined) return new Response(null, { status: 404 });
    let offset = 0;
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (options.stall?.url === url && chunks >= options.stall.afterChunks) {
          const signal = init?.signal;
          await new Promise<void>((resolve) => {
            if (signal?.aborted === true) resolve();
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          controller.error(signal?.reason);
          return;
        }
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
        chunks += 1;
        pulled.set(url, chunks);
      },
    });
    return new Response(body, { status: 200 });
  };
  return { fetch: fake as typeof fetch, calls, inits, pulled };
}

export interface StoredEntry {
  bytes: Uint8Array<ArrayBuffer>;
  headers: [string, string][];
}

/** A `Cache`-shaped store whose entries tests can read and change directly. */
export class MemoryStore implements ModelFileStore {
  readonly entries: Map<string, StoredEntry> = new Map<string, StoredEntry>();
  failPut = false;

  async match(key: string): Promise<Response | undefined> {
    const entry = this.entries.get(key);
    return entry === undefined ? undefined : new Response(entry.bytes, { headers: entry.headers });
  }

  async put(key: string, response: Response): Promise<void> {
    if (this.failPut) throw new DOMException('quota', 'QuotaExceededError');
    this.entries.set(key, {
      bytes: new Uint8Array(await response.arrayBuffer()),
      headers: [...response.headers],
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async keys(): Promise<{ readonly url: string }[]> {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
}

/** A `CacheStorage` stand-in that logs which caches were opened. */
export class MemoryCacheStorage {
  readonly stores: Map<string, MemoryStore> = new Map<string, MemoryStore>();
  readonly opened: string[] = [];

  async has(name: string): Promise<boolean> {
    return this.stores.has(name);
  }

  async open(name: string): Promise<MemoryStore> {
    this.opened.push(name);
    let store = this.stores.get(name);
    if (store === undefined) {
      store = new MemoryStore();
      this.stores.set(name, store);
    }
    return store;
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
}

export async function readBytes(response: Response | undefined): Promise<Uint8Array> {
  if (response === undefined) throw new Error('expected a response');
  return new Uint8Array(await response.arrayBuffer());
}
