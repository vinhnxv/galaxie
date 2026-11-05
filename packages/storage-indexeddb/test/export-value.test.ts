// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { exportValue } from '../src/session-export.js';

test('converts bytes to marked base64 and returns detached frozen JSON values', () => {
  const original = { bytes: new Uint8Array([0, 128, 255]), nested: [false, null, 3] };
  const exported = exportValue(original);
  expect(exported).toEqual({ bytes: { type: 'base64', data: 'AID/' }, nested: [false, null, 3] });
  expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);
  expect(Object.isFrozen(exported)).toBe(true);
  original.bytes.fill(1);
  original.nested[0] = true;
  expect(exported).toEqual({ bytes: { type: 'base64', data: 'AID/' }, nested: [false, null, 3] });
});

test('replaces unconvertible leaves without calling getters or toJSON or exposing errors', () => {
  const bad = {
    toJSON() {
      throw new Error('private host error');
    },
    get secret(): string {
      throw new Error('private getter');
    },
  };
  const cyclic: Record<string, unknown> = { good: 'preserved' };
  cyclic['self'] = cyclic;
  expect(
    exportValue({
      cyclic,
      bad,
      error: new Error('private host error'),
      bigint: 1n,
      missing: undefined,
      infinite: Infinity,
    }),
  ).toEqual({
    cyclic: { good: 'preserved', self: '[unavailable]' },
    bad: { toJSON: '[unavailable]', secret: '[unavailable]' },
    error: '[unavailable]',
    bigint: '[unavailable]',
    missing: '[unavailable]',
    infinite: '[unavailable]',
  });
});
