// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { isValidScope } from '../../packages/core/src/ids.js';
import { StorageError } from '../../packages/storage-indexeddb/src/errors.js';
import { validateScope } from '../../packages/storage-indexeddb/src/keys.js';

const cases: ReadonlyArray<{
  readonly name: string;
  readonly value: unknown;
  readonly valid: boolean;
}> = [
  { name: 'plain identifier', value: 'app', valid: true },
  { name: 'allowed punctuation', value: 'a.b_c:d-e', valid: true },
  {
    name: 'all allowed characters',
    value: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-',
    valid: true,
  },
  { name: 'one character', value: 'a', valid: true },
  { name: '128 characters', value: 'a'.repeat(128), valid: true },
  { name: 'empty string', value: '', valid: false },
  { name: '129 characters', value: 'a'.repeat(129), valid: false },
  { name: 'space', value: 'bad id', valid: false },
  { name: 'slash', value: 'a/b', valid: false },
  { name: 'non-ASCII letter', value: 'a\u00e9', valid: false },
  { name: 'newline', value: 'app\n', valid: false },
  { name: 'number', value: 12, valid: false },
  { name: 'null', value: null, valid: false },
  { name: 'undefined', value: undefined, valid: false },
  { name: 'object', value: {}, valid: false },
];

test.each(cases)('core and storage agree on $name', ({ value, valid }) => {
  expect(isValidScope(value)).toBe(valid);
  if (valid) expect(() => validateScope(value)).not.toThrow();
  else {
    expect(() => validateScope(value)).toThrowError(StorageError);
    expect(() => validateScope(value)).toThrowError(
      expect.objectContaining({ code: 'invalid', message: 'The storage request is invalid.' }),
    );
  }
});
