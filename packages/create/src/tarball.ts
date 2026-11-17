// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
export class TarballError extends Error {}

/** Read npm's manifest without extraction; path-overriding extended headers are refused. */
export async function readTarballManifest(
  path: string,
  name: string,
  maxBytes: number = 512 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  const source = createReadStream(path);
  const decoded = source.pipe(createGunzip());
  source.on('error', (error) => decoded.destroy(error));
  let buffer: Buffer = Buffer.alloc(0);
  let remaining = 0;
  let padding = 0;
  let manifest = false;
  const parts: Buffer[] = [];
  let found: Record<string, unknown> | undefined;
  let ended = false;
  let decodedBytes = 0;
  try {
    for await (const chunk of decoded) {
      decodedBytes += (chunk as Buffer).length;
      if (decodedBytes > maxBytes) throw new Error();
      if (ended) {
        if ((chunk as Buffer).some((byte) => byte !== 0)) throw new Error();
        continue;
      }
      buffer = buffer.length === 0 ? (chunk as Buffer) : Buffer.concat([buffer, chunk as Buffer]);
      while (buffer.length > 0) {
        if (remaining > 0) {
          const count = Math.min(remaining, buffer.length);
          if (manifest) parts.push(buffer.subarray(0, count));
          buffer = buffer.subarray(count);
          remaining -= count;
          if (remaining > 0) break;
          if (manifest) {
            const value: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
            if (value === null || typeof value !== 'object' || Array.isArray(value))
              throw new Error();
            found = value as Record<string, unknown>;
            manifest = false;
            parts.length = 0;
          }
        }
        if (padding > 0) {
          const count = Math.min(padding, buffer.length);
          buffer = buffer.subarray(count);
          padding -= count;
          if (padding > 0) break;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (header.every((byte) => byte === 0)) {
          if (buffer.some((byte) => byte !== 0)) throw new Error();
          buffer = Buffer.alloc(0);
          ended = true;
          break;
        }
        const text = (start: number, end: number): string =>
          header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
        const size = text(124, 136).trim();
        if (!/^[0-7]+$/.test(size)) throw new Error();
        remaining = Number.parseInt(size, 8);
        if (!Number.isSafeInteger(remaining)) throw new Error();
        padding = (512 - (remaining % 512)) % 512;
        const prefix = text(345, 500);
        if (['x', 'g', 'L', 'K'].includes(text(156, 157))) throw new Error();
        const entry = `${prefix === '' ? '' : `${prefix}/`}${text(0, 100)}`;
        manifest = entry === 'package/package.json';
        if (manifest && found !== undefined)
          throw new TarballError(`${name}: tarball contains more than one package/package.json.`);
        if (
          manifest &&
          (remaining === 0 ||
            remaining > 1_048_576 ||
            !['0', '\0'].includes(text(156, 157) || '\0'))
        )
          throw new Error();
      }
    }
    if (found === undefined || !ended || remaining > 0 || padding > 0 || buffer.length > 0)
      throw new Error();
    return found;
  } catch (error) {
    if (error instanceof TarballError) throw error;
    throw new TarballError(`${name}: could not read tarball package/package.json.`);
  } finally {
    source.destroy();
    decoded.destroy();
  }
}
