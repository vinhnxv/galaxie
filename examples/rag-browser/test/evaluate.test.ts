// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { evaluate, sampleQuestions } from '../src/host/evaluate.js';

test('computes recall and reciprocal rank including a missing passage', async () => {
  const questions = [
    { id: '1', question: 'first', answers: [], passageId: 'target' },
    { id: '2', question: 'second', answers: [], passageId: 'missing' },
  ];
  const search = async (): Promise<{
    passages: { id: string; title: string; text: string; score: number }[];
  }> => ({
    passages: [
      { id: 'other', title: '', text: '', score: 1 },
      { id: 'target', title: '', text: '', score: 0.5 },
    ],
  });
  expect(await evaluate(questions, search)).toEqual(
    ['fulltext', 'vector', 'hybrid'].map((mode) => ({
      mode,
      n: 2,
      recall1: 0,
      recall5: 0.5,
      recall10: 0.5,
      mrr: 0.25,
    })),
  );
  expect(sampleQuestions(questions)).toEqual(sampleQuestions(questions));
  const controller = new AbortController();
  controller.abort();
  await expect(evaluate(questions, search, { signal: controller.signal })).rejects.toThrow();
});
