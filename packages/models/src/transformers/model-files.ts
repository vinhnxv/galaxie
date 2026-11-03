// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { ModelError } from '../errors.js';
import {
  localModelKey,
  modelFileUrl,
  parseModelRecord,
  type TransformersModelFile,
  type TransformersModelRecord,
  totalBytes,
} from './model-record.js';

/** Written next to every stored file so the page can compare sizes without reading bytes. */
export const storedBytesHeader = 'x-galaxie-bytes';
export const storedSha256Header = 'x-galaxie-sha256';

/** The slice of `Cache` the store needs; tests supply an in-memory one. */
export interface ModelFileStore {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** The cache the runtime reads: verified bytes only, never writable. */
export interface ReadOnlyModelCache {
  match(key: string): Promise<Response | undefined>;
  put(): Promise<never>;
}

export interface VerifiedModelFiles {
  readonly cache: ReadOnlyModelCache;
  /** Drops the verified buffers once the runtime has read them. */
  release(): void;
}

export interface ModelFilesProgress {
  readonly phase: 'download' | 'verify';
  /** Bytes finished over the record's total; never decreases and reaches 1 after the last verify. */
  readonly fraction: number;
}

export interface LoadModelFilesOptions {
  readonly record: TransformersModelRecord;
  readonly store: ModelFileStore;
  /** Only a host consent path sets this. Without it a missing or invalid file fails and nothing is fetched. */
  readonly allowDownload?: boolean;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  /** A file transfer with no bytes for this long fails. Defaults to 60 seconds. */
  readonly idleTimeoutMs?: number;
  readonly onProgress?: (progress: ModelFilesProgress) => void;
}

/** A body whose length differs from the record; mapped to `integrity` for downloads, a refetch for stored files. */
class SizeMismatch extends Error {}

/** Whether a stored entry carries the markers written for this record file. */
export function isStoredFile(response: Response, file: TransformersModelFile): boolean {
  return (
    response.headers.get(storedBytesHeader) === String(file.bytes) &&
    response.headers.get(storedSha256Header) === file.sha256
  );
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  } catch {
    throw new ModelError('unavailable', 'load_failed');
  }
}

/** Streams a body into one buffer allocated at the recorded size and refuses any other length. */
async function readExactly(
  body: ReadableStream<Uint8Array>,
  expected: number,
  onLoaded: (loaded: number) => void,
  signal: AbortSignal | undefined,
): Promise<Uint8Array<ArrayBuffer>> {
  let buffer: Uint8Array<ArrayBuffer>;
  try {
    buffer = new Uint8Array(expected);
  } catch {
    throw new ModelError('unavailable', 'load_failed');
  }
  const reader = body.getReader();
  let loaded = 0;
  let finished = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      if (loaded + next.value.length > expected) throw new SizeMismatch();
      buffer.set(next.value, loaded);
      loaded += next.value.length;
      onLoaded(loaded);
    }
    finished = true;
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
  }
  if (loaded !== expected) throw new SizeMismatch();
  return buffer;
}

/** Reads a stored entry that carries this record's markers; anything else is treated as absent. */
async function readStored(
  store: ModelFileStore,
  url: string,
  file: TransformersModelFile,
  signal: AbortSignal | undefined,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  let stored: Response | undefined;
  try {
    stored = await store.match(url);
  } catch (error) {
    // A failing store is not evidence that the entry is bad, so it is left alone.
    if (signal?.aborted === true) throw error;
    throw new ModelError('unavailable', 'load_failed');
  }
  if (stored === undefined) return undefined;
  if (stored.body === null || !isStoredFile(stored, file)) {
    void stored.body?.cancel().catch(() => undefined);
    return undefined;
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readExactly(stored.body, file.bytes, () => undefined, signal);
  } catch (error) {
    if (error instanceof SizeMismatch) return undefined;
    if (signal?.aborted === true || error instanceof ModelError) throw error;
    throw new ModelError('unavailable', 'load_failed');
  }
  return (await sha256Hex(bytes)) === file.sha256 ? bytes : undefined;
}

async function download(
  url: string,
  file: TransformersModelFile,
  options: LoadModelFilesOptions,
  onLoaded: (loaded: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const { signal, fetch: fetcher = globalThis.fetch, idleTimeoutMs = 60_000 } = options;
  const idle = new AbortController();
  const combined = signal === undefined ? idle.signal : AbortSignal.any([signal, idle.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), idleTimeoutMs);
  };
  try {
    touch();
    const response = await fetcher(url, {
      credentials: 'omit',
      signal: combined,
    });
    if (!response.ok || response.body === null) {
      void response.body?.cancel().catch(() => undefined);
      throw new ModelError('unavailable', 'download_failed');
    }
    return await readExactly(
      response.body,
      file.bytes,
      (loaded) => {
        touch();
        onLoaded(loaded);
      },
      combined,
    );
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason;
    if (error instanceof SizeMismatch) throw new ModelError('unavailable', 'integrity');
    if (error instanceof ModelError) throw error;
    throw new ModelError('unavailable', 'download_failed');
  } finally {
    clearTimeout(timer);
  }
}

function storedResponse(bytes: Uint8Array<ArrayBuffer>, file: TransformersModelFile): Response {
  return new Response(bytes, {
    headers: {
      'content-length': String(bytes.length),
      'content-type': 'application/octet-stream',
      [storedBytesHeader]: String(file.bytes),
      [storedSha256Header]: file.sha256,
    },
  });
}

function runtimeResponse(bytes: Uint8Array<ArrayBuffer>): Response {
  return new Response(bytes, {
    headers: { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream' },
  });
}

/** The runtime's `env.fetch`: it must never reach the network, so any call fails with a fixed error. */
export async function deniedFetch(): Promise<never> {
  throw new Error('The verified model file is unavailable.');
}

/**
 * Makes every file of the record available as verified bytes. A stored file is re-hashed on every
 * call; an invalid or missing one is deleted and, only when the caller allows it, fetched, hashed
 * and stored. The returned cache answers from the buffers hashed here, never from the store again.
 */
export async function loadVerifiedModelFiles(
  options: LoadModelFilesOptions,
): Promise<VerifiedModelFiles> {
  const { store, signal, onProgress } = options;
  // The record may come from a message or a file, so it is checked again here.
  const record = parseModelRecord(options.record);
  const total = totalBytes(record);
  const verified = new Map<string, Uint8Array<ArrayBuffer>>();
  let finished = 0;
  for (const file of record.files) {
    signal?.throwIfAborted();
    const url = modelFileUrl(record, file);
    let bytes = await readStored(store, url, file, signal);
    if (bytes === undefined) {
      await store.delete(url);
      if (options.allowDownload !== true) throw new ModelError('unavailable', 'integrity');
      bytes = await download(url, file, options, (loaded) => {
        // The last chunk is reported by the verify step that follows.
        if (loaded < file.bytes)
          onProgress?.({ phase: 'download', fraction: (finished + loaded) / total });
      });
      if ((await sha256Hex(bytes)) !== file.sha256)
        throw new ModelError('unavailable', 'integrity');
      signal?.throwIfAborted();
      try {
        await store.put(url, storedResponse(bytes, file));
      } catch {
        await store.delete(url).catch(() => false);
        throw new ModelError('unavailable', 'download_failed');
      }
    }
    verified.set(url, bytes);
    verified.set(localModelKey(record, file), bytes);
    finished += file.bytes;
    onProgress?.({ phase: 'verify', fraction: finished / total });
  }
  signal?.throwIfAborted();
  return {
    cache: {
      async match(key) {
        const bytes = verified.get(key);
        return bytes === undefined ? undefined : runtimeResponse(bytes);
      },
      async put() {
        throw new Error('The verified model cache is read-only.');
      },
    },
    release() {
      verified.clear();
    },
  };
}
