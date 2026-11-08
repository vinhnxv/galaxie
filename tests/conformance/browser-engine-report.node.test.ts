// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { summarize } from '../../scripts/check-browser-engine.ts';

const file = '/work/repo/tests/conformance/example.test.ts';
const report = {
  testResults: [
    {
      name: file,
      assertionResults: [
        { fullName: 'passes', status: 'passed' },
        { fullName: 'known break', status: 'failed' },
        { fullName: 'new break', status: 'failed' },
        { fullName: 'skipped', status: 'pending' },
      ],
    },
  ],
};

test('only failures outside the known list are unexpected', () => {
  const summary = summarize(report, ['tests/conformance/example.test.ts | known break']);
  expect(summary.total).toBe(4);
  expect(summary.passed).toBe(1);
  expect(summary.skipped).toBe(1);
  expect(summary.failed).toHaveLength(2);
  expect(summary.unexpected).toEqual(['tests/conformance/example.test.ts | new break']);
  expect(summary.fixed).toEqual([]);
});

test('a known failure that passes is reported as fixed', () => {
  const summary = summarize(report, ['tests/conformance/example.test.ts | passes']);
  expect(summary.fixed).toEqual(['tests/conformance/example.test.ts | passes']);
});

test('an empty report has no cases, which the script treats as a launch failure', () => {
  expect(summarize({ testResults: [] }, []).total).toBe(0);
});

test('the known-failure file names only the engines the lane runs', () => {
  const known = JSON.parse(
    readFileSync(new URL('../browser-engines-known-failures.json', import.meta.url), 'utf8'),
  ) as Record<string, readonly string[]>;
  expect(Object.keys(known).sort()).toEqual(['firefox', 'webkit']);
});
