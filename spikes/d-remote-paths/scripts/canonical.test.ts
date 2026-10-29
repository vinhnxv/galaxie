// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonical, digest } from '../src/canonical.ts';

test('JCS orders UTF-16 keys and uses ECMAScript number serialization', async () => {
  assert.equal(
    canonical({ z: [1e30, 4.5, 0.002, 1e-27, -0], a: '\u000f\n' }),
    '{"a":"\\u000f\\n","z":[1e+30,4.5,0.002,1e-27,0]}',
  );
  assert.equal(canonical({ '\u20ac': 1, '\r': 2, '😀': 3, דּ: 4 }), '{"\\r":2,"€":1,"😀":3,"דּ":4}');
  assert.equal(await digest({ a: 1, b: 2 }), await digest({ b: 2, a: 1 }));
  assert.notEqual(await digest({ a: 1 }), await digest({ a: 2 }));
  for (const invalid of [NaN, Infinity, undefined, '\ud800', { a: undefined }])
    assert.throws(() => canonical(invalid), /invalid_json/);
});
