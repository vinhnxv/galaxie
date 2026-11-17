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
