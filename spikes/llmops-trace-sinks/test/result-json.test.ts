// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { resultJson } from '../src/result-json.js';

test.each(['linear', 'tool-call', 'interrupt-resume', 'model-failure'])(
  'serializes the committed Node %s result byte for byte without Biome',
  (name) => {
    const committed = readFileSync(
      new URL(`../results/node-${name}.json`, import.meta.url),
      'utf8',
    );
    expect(resultJson(JSON.parse(committed))).toBe(committed);
  },
);

test('keeps a non-last array expanded when its trailing comma would pass column 100', () => {
  const long = Array.from({ length: 87 }, () => 'a').join('');
  const value = { o: { k: [long], z: 1 } };
  const last = { o: { z: 1, k: [long] } };
  expect(resultJson(value)).toContain('"k": [\n');
  expect(resultJson(last)).toContain(`"k": ["${long}"]`);
  expect(resultJson({ a: [{}, 1] })).toContain('"a": [{}, 1]');
});
