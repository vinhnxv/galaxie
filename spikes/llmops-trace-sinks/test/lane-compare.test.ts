// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { compareLanes, laneSpecificAttributes } from '../src/lane-compare.js';

const folder = new URL('../results/', import.meta.url);
interface RecordFile {
  variants: {
    backends: Record<
      string,
      { name: string; parentId: string | null; attributes: Record<string, unknown> }[]
    >;
  }[];
}
function readRecord(name: string): RecordFile {
  return JSON.parse(readFileSync(new URL(name, folder), 'utf8')) as RecordFile;
}

for (const scenario of ['linear', 'interrupt-resume']) {
  test(`${scenario} Node records compare equal to themselves`, () => {
    const record = readRecord(`node-${scenario}.json`);
    expect(compareLanes(record, record)).toEqual([]);
  });
  test.skipIf(!existsSync(new URL(`browser-${scenario}.json`, folder)))(
    `${scenario} committed browser and Node records differ only by listed lane attributes`,
    () => {
      expect(
        compareLanes(readRecord(`browser-${scenario}.json`), readRecord(`node-${scenario}.json`)),
      ).toEqual([]);
    },
  );
}

test.each(['tokens', 'span', 'parent', 'unlisted attribute'] as const)(
  'lane comparison rejects changed %s in real records',
  (mutation) => {
    const node = readRecord('node-linear.json');
    const browser = structuredClone(node);
    const spans = browser.variants[0]?.backends['mlflow'];
    const model = spans?.find((span) => span.name.startsWith('chat'));
    if (!model || !spans) throw new Error('Missing model record');
    if (mutation === 'tokens') model.attributes['gen_ai.usage.input_tokens'] = 99;
    if (mutation === 'span') spans.push(structuredClone(model));
    if (mutation === 'parent') model.parentId = 'changed-parent';
    if (mutation === 'unlisted attribute') model.attributes['unlisted.lane.attribute'] = 'browser';
    expect(compareLanes(browser, node).length).toBeGreaterThan(0);
  },
);

test('only a listed attribute map key is ignored, with its reason kept as data', () => {
  const allowlist = [
    { key: 'fixture.lane', reason: 'Synthetic browser versus Node representation.' },
  ];
  const browser = { attributes: { 'fixture.lane': 'browser', kept: 1 }, 'fixture.lane': 'same' };
  const node = { attributes: { 'fixture.lane': 'node', kept: 1 }, 'fixture.lane': 'same' };
  expect(compareLanes(browser, node, allowlist)).toEqual([]);
  expect(compareLanes({ ...browser, 'fixture.lane': 'different' }, node, allowlist)).toEqual([
    { path: '$.fixture.lane', reason: 'value differs' },
  ]);
  expect(compareLanes(browser, node).length).toBeGreaterThan(0);
  expect(laneSpecificAttributes.every((item) => item.reason.length > 0)).toBe(true);
});
