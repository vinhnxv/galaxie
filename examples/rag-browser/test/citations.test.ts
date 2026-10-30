// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { citeAnswer } from '../src/agent/citations.js';

test('keeps valid markers in first-seen order and removes out-of-range markers', () => {
  const passages = [
    { id: 'a', title: 'A', text: 'one', score: 1 },
    { id: 'b', title: 'B', text: 'two', score: 0.5 },
    { id: 'c', title: 'C', text: 'three', score: 0.2 },
  ];
  expect(citeAnswer('Paris [2], [2], [7] and [1].', passages)).toEqual({
    answer: 'Paris [2], [2],  and [1].',
    citations: [
      { marker: 2, passageId: 'b', title: 'B', text: 'two' },
      { marker: 1, passageId: 'a', title: 'A', text: 'one' },
    ],
  });
  expect(citeAnswer('No markers.', passages)).toEqual({ answer: 'No markers.', citations: [] });
  expect(citeAnswer('Unknown [0] [9].', [])).toEqual({ answer: 'Unknown  .', citations: [] });
});
