// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { chunkText } from '../src/retrieval/chunk.js';

test('keeps blank-line paragraphs separate and ignores whitespace', () => {
  expect(chunkText(' First paragraph.\n\nSecond paragraph. ')).toEqual([
    'First paragraph.',
    'Second paragraph.',
  ]);
  expect(chunkText(' \n\n ')).toEqual([]);
});

test('splits long paragraphs into at most 1000 characters at sentence ends', () => {
  const text = `${'a'.repeat(899)}. ${'b'.repeat(899)}. ${'c'.repeat(696)}.`;
  const passages = chunkText(text);
  expect(passages).toHaveLength(3);
  expect(passages.every((passage) => passage.length <= 1000)).toBe(true);
  expect(passages.join(' ')).toBe(text);
});
