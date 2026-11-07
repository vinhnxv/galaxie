// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Digest and verified Cache Storage pattern adapted from
// spikes/b-local-inference/src/arms/ort/model-files.ts. Unknown digests never become verified.
import type { FileVerification, InventoryEntry, InventoryFile } from '../results.js';
import { ArmFailure } from './types.js';

export function fileUrl(entry: InventoryEntry, file: InventoryFile): string {
  if (!entry.revision) throw new ArmFailure('download_failed');
  return entry.source.startsWith('https://huggingface.co/')
    ? `${entry.source}/resolve/${entry.revision}/${file.path}`
    : `${entry.source.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/${entry.revision}/${file.path}`;
}
export async function digest(
  bytes: Uint8Array<ArrayBuffer>,
  kind: 'sha256' | 'git-blob-sha1',
): Promise<string> {
  let input = bytes;
  if (kind === 'git-blob-sha1') {
    const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
    input = new Uint8Array(header.length + bytes.length);
    input.set(header);
    input.set(bytes, header.length);
  }
  const result = await crypto.subtle.digest(kind === 'sha256' ? 'SHA-256' : 'SHA-1', input);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function fetchVerified(
  entry: InventoryEntry,
  file: InventoryFile,
  progress: (loaded: number, total: number | null) => void,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; verification: FileVerification; downloadMs: number }> {
  const cache = await caches.open(`decision-models-${entry.id}-${entry.revision}`);
  const url = fileUrl(entry, file);
  const cached = await cache.match(url);
  const start = performance.now();
  let downloadMs = 0;
  let bytes: Uint8Array<ArrayBuffer>;
  if (cached) bytes = new Uint8Array(await cached.arrayBuffer());
  else {
    const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok || !response.body) throw new ArmFailure('download_failed');
    const reader = response.body.getReader();
    // A pinned size lets the bytes land in one buffer; holding every chunk and then copying would
    // double the memory of a multi-gigabyte file.
    const chunks: Uint8Array[] = [];
    const target = file.bytes === null ? null : new Uint8Array(file.bytes);
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (file.bytes !== null && size > file.bytes) {
        await reader.cancel();
        throw new ArmFailure('file_mismatch', [
          {
            path: file.path,
            status: 'mismatch',
            actualBytes: size,
            computedDigest: null,
            downloaded: true,
          },
        ]);
      }
      if (target) target.set(value, size - value.byteLength);
      else chunks.push(value);
      progress(size, file.bytes);
    }
    if (target) bytes = target.subarray(0, size);
    else {
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    downloadMs = performance.now() - start;
  }
  const computedDigest = await digest(bytes, file.digest?.kind ?? 'sha256');
  const mismatch =
    (file.bytes !== null && bytes.byteLength !== file.bytes) ||
    (file.digest !== null && computedDigest !== file.digest.value);
  const verification: FileVerification = {
    path: file.path,
    status: mismatch ? 'mismatch' : file.digest ? 'verified' : 'unverified_no_digest',
    actualBytes: bytes.byteLength,
    computedDigest,
    downloaded: !cached,
  };
  if (mismatch) {
    await cache.delete(url);
    throw new ArmFailure('file_mismatch', [verification]);
  }
  if (!cached) await cache.put(url, new Response(bytes));
  progress(bytes.byteLength, file.bytes);
  return { bytes, verification, downloadMs };
}
