// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/envelope.js';
import { StorageError, storageError } from '../src/errors.js';
import { checkpointKey, prefixRange, validateScope } from '../src/keys.js';

const serde = {
  async dumpsTyped(value: unknown): Promise<[string, Uint8Array]> {
    return ['json', new TextEncoder().encode(JSON.stringify(value))];
  },
  async loadsTyped(type: string, bytes: Uint8Array | string): Promise<unknown> {
    if (type !== 'json' || typeof bytes === 'string') throw new Error('private text');
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  },
};

describe('serialized envelopes', () => {
  it('preserves the serializer tag and bytes and round-trips values', async () => {
    const value = { answer: ['yes', 3, false] };
    const envelope = await encode(serde, value);
    expect(envelope).toEqual({
      v: 1,
      type: 'json',
      bytes: new TextEncoder().encode(JSON.stringify(value)),
    });
    expect(await decode(serde, envelope)).toEqual(value);
  });

  it.each([
    null,
    {},
    { v: 2, type: 'json', bytes: new Uint8Array() },
    { v: 1, bytes: new Uint8Array() },
    { v: 1, type: 'json' },
    { v: 1, type: 1, bytes: new Uint8Array() },
    { v: 1, type: 'json', bytes: [] },
    { v: 1, type: 'json', bytes: new Uint8Array([255]) },
  ])('rejects a malformed envelope with a fixed error: %j', async (value) => {
    await expect(decode(serde, value)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'corrupt',
      message: 'Stored checkpoint data is corrupt.',
    });
  });
});

describe('storage boundaries', () => {
  it.each(['', 'a/b', 'two words', 'é', 'x'.repeat(129), undefined, 3])(
    'rejects an invalid scope: %j',
    (value) => {
      expect(() => validateScope(value)).toThrowError(new StorageError('invalid'));
    },
  );

  it('accepts bounded scope identifiers and encodes keys without delimiters', () => {
    for (const value of ['app:one-2.3_test', 'a'.repeat(128)]) validateScope(value);
    expect(checkpointKey('app', 'user', 'a:b', 'c', 'd')).toEqual(['app', 'user', 'a:b', 'c', 'd']);
    // Key ranges are browser-only; importing the helper must also work on Node.
    expect(typeof prefixRange).toBe('function');
  });

  it.each([
    ['QuotaExceededError', 'quota'],
    ['AbortError', 'aborted'],
    ['VersionError', 'newer_schema'],
    ['UnknownError', 'unavailable'],
  ])('maps %s without retaining host text or cause', (name, code) => {
    const error = storageError(new DOMException('private host text', name));
    expect(error.code).toBe(code);
    expect(error.message).not.toContain('private');
    expect(Object.hasOwn(error, 'cause')).toBe(false);
  });
});
