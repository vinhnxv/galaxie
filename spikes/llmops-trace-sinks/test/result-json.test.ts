// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { resultJson } from '../src/result-json.js';
import { writeFeedback } from '../src/score-readback.js';

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  writeFileSync: vi.fn(),
}));
vi.mock('../src/secrets.js', () => ({ readEnv: () => ({}) }));

test.each([
  'node-linear',
  'node-tool-call',
  'node-interrupt-resume',
  'node-model-failure',
  'browser-linear',
  'browser-interrupt-resume',
  'browser-evidence',
  'browser-close',
  'browser-feedback',
  'feedback-scores',
  'sessions',
  'mlflow-evaluation',
  'coverage-matrix',
])('serializes the committed %s result byte for byte without Biome', (name) => {
  const committed = readFileSync(new URL(`../results/${name}.json`, import.meta.url), 'utf8');
  expect(resultJson(JSON.parse(committed))).toBe(committed);
});

test.each(['src/score-readback.ts', 'test/browser.test.ts', 'test/coverage-live.test.ts'])(
  '%s uses the local serializer without a formatter subprocess',
  (path) => {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    expect(source.includes('resultJson(')).toBe(true);
    expect(source.includes('node:child_process')).toBe(false);
    expect(source.includes('node_modules/.bin/biome')).toBe(false);
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

test('the feedback writer writes local JSON bytes without invoking a formatter', () => {
  writeFeedback('offline-feedback.json', { values: [1, 2] });
  expect(writeFileSync).toHaveBeenCalledExactlyOnceWith(
    new URL('../results/offline-feedback.json', import.meta.url),
    '{\n  "values": [1, 2]\n}\n',
  );
});
