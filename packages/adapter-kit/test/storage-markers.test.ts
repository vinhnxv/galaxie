// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { storageMarkerCode } from '../src/index.js';

test.each([
  ['invalidated', 'stale'],
  ['fenced', 'fenced'],
  ['unrecoverable', 'unrecoverable'],
] as const)('an own %s marker maps to %s', (marker, code) => {
  expect(storageMarkerCode(Object.assign(new Error('x'), { [marker]: true }))).toBe(code);
});

test('inherited markers, accessors and non-true values are ignored', () => {
  const inherited = Object.create({ fenced: true }) as object;
  const accessor = Object.defineProperty(new Error('x'), 'invalidated', { get: () => true });
  expect(storageMarkerCode(inherited)).toBeUndefined();
  expect(storageMarkerCode(accessor)).toBeUndefined();
  expect(storageMarkerCode(Object.assign(new Error('x'), { fenced: 'yes' }))).toBeUndefined();
  expect(storageMarkerCode('invalidated')).toBeUndefined();
  expect(storageMarkerCode(null)).toBeUndefined();
});
