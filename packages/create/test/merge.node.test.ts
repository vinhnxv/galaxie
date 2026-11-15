// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { MergeConflictError, mergeFragments } from '../src/merge.js';

test('objects and equal scalars merge, preserving source ownership through later fragments', () => {
  expect(
    mergeFragments([
      { layer: 'base', value: { scripts: { dev: 'vite' }, dependencies: { react: '19.3.1' } } },
      { layer: 'kind', value: { scripts: { dev: 'vite', check: 'node check.ts' } } },
    ]),
  ).toEqual({
    scripts: { dev: 'vite', check: 'node check.ts' },
    dependencies: { react: '19.3.1' },
  });
  expect(() =>
    mergeFragments([
      { layer: 'base', value: { scripts: { check: 'old' } } },
      { layer: 'kind', value: { license: 'Apache-2.0' } },
      { layer: 'framework', value: { scripts: { check: 'new' } } },
    ]),
  ).toThrow('package.json.scripts.check between layers base and framework');
});

test.each([{ scripts: { check: 'different' } }, { dependencies: { react: '20.0.0' } }])(
  'conflicting scripts and dependency versions fail: %j',
  (value) => {
    expect(() =>
      mergeFragments([
        {
          layer: 'base',
          value: { scripts: { check: 'node check.ts' }, dependencies: { react: '19.3.1' } },
        },
        { layer: 'kind', value },
      ]),
    ).toThrow(MergeConflictError);
    expect(() =>
      mergeFragments([
        { layer: 'base', value },
        { layer: 'kind', value },
      ]),
    ).not.toThrow();
  },
);

test('only compiler types and include arrays union in layer order', () => {
  expect(
    mergeFragments(
      [
        { layer: 'base', value: { compilerOptions: { types: ['vite/client'] }, include: ['src'] } },
        {
          layer: 'kind',
          value: {
            compilerOptions: { types: ['node', 'vite/client'] },
            include: ['server', 'src'],
          },
        },
      ],
      'tsconfig.json',
    ),
  ).toEqual({ compilerOptions: { types: ['vite/client', 'node'] }, include: ['src', 'server'] });
  expect(() =>
    mergeFragments([
      { layer: 'base', value: { files: ['a'] } },
      { layer: 'kind', value: { files: ['a'] } },
    ]),
  ).toThrow('package.json.files');
  expect(() =>
    mergeFragments([
      { layer: 'base', value: { compilerOptions: { types: ['node'] } } },
      { layer: 'kind', value: { compilerOptions: { types: [3] } } },
    ]),
  ).toThrow('compilerOptions.types');
});
