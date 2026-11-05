// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { canonical } from '../src/canonical.js';
import { toolPin } from '../src/index.js';

test('canonicalizes RFC 8785 serialization and UTF-16 property ordering', () => {
  expect(
    canonical({
      numbers: [Number('333333333.33333329'), 1e30, 4.5, 2e-3, 1e-27],
      string: '\u20ac$\u000f\nA\'B"\\"/',
      literals: [null, true, false],
    }),
  ).toBe(
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\"/"}',
  );
  const keys = ['\u20ac', '\r', '\ufb33', '1', '\ud83d\ude00', '\u0080', '\u00f6'];
  expect(canonical(Object.fromEntries(keys.map((key) => [key, key])))).toBe(
    `{${['\r', '1', '\u0080', '\u00f6', '\u20ac', '\ud83d\ude00', '\ufb33'].map((key) => `${JSON.stringify(key)}:${JSON.stringify(key)}`).join(',')}}`,
  );
  expect(canonical(-0)).toBe('0');
});

test.each([
  NaN,
  Infinity,
  -Infinity,
  '\ud800',
  '\udfff',
  { '\ud800': 1 },
  undefined,
  [undefined],
  new Date(),
])('rejects non-JSON JCS input without its contents', (value) => {
  expect(() => canonical(value)).toThrow('The request is invalid.');
});

test('pins every declared field, ignores absent fields and sorts nested objects', async () => {
  const tool = {
    name: 'lookup',
    title: 'Lookup',
    description: 'Description',
    inputSchema: { type: 'object' as const, properties: {} },
    outputSchema: { type: 'object' as const },
    annotations: { readOnlyHint: true },
  };
  const pin = await toolPin(tool);
  expect(pin).toMatch(/^[a-f0-9]{64}$/);
  expect(await toolPin({ ...tool, inputSchema: { properties: {}, type: 'object' } })).toBe(pin);
  for (const field of [
    'name',
    'title',
    'description',
    'inputSchema',
    'outputSchema',
    'annotations',
  ] as const) {
    const changed = {
      ...tool,
      [field]: field.endsWith('Schema')
        ? { type: 'object', required: ['id'] }
        : field === 'annotations'
          ? { readOnlyHint: false }
          : 'changed',
    };
    expect(await toolPin(changed)).not.toBe(pin);
  }
  expect(await toolPin({ name: 'lookup', inputSchema: { type: 'object' } })).toBe(
    await toolPin({ name: 'lookup', inputSchema: { type: 'object' }, title: undefined }),
  );
});
