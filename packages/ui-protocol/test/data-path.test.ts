// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { resolveDataPath } from '../src/index.js';

test('data paths share validator root, escaping, array and template scope semantics', () => {
  const model = { '': 'empty', 'a/b': { '~': ['first', 'second'] }, title: 'Root' };
  expect(resolveDataPath('', model)).toBe(model);
  expect(resolveDataPath('/', model)).toBe('empty');
  expect(resolveDataPath('/a~1b/~0/1', model)).toBe('second');
  expect(resolveDataPath('title', model, { title: 'Item' })).toBe('Item');
  expect(resolveDataPath('/title', model, { title: 'Item' })).toBe('Root');
  expect(resolveDataPath('title', model)).toBeUndefined();
  for (const path of ['/a~2b', '/a~1b/~0/01', '/a~1b/~0/-', '/missing', '/toString']) {
    expect(resolveDataPath(path, model)).toBeUndefined();
  }
  expect(resolveDataPath('__proto__', model, JSON.parse('{"__proto__":"own"}'))).toBe('own');
  expect(resolveDataPath('constructor', model, {})).toBeUndefined();
});
