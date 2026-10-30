// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { Corpus } from '../corpus.js';
import type { SearchInput, SearchMode, SearchResult } from '../retrieval/protocol.js';

export interface EvaluationRow {
  mode: SearchMode;
  n: number;
  recall1: number;
  recall5: number;
  recall10: number;
  mrr: number;
}
export function sampleQuestions(questions: Corpus['questions']): Corpus['questions'] {
  const sample = [...questions];
  let seed = 20261030;
  for (let i = sample.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const left = sample[i];
    const right = sample[j];
    if (left && right) {
      sample[i] = right;
      sample[j] = left;
    }
  }
  return sample.slice(0, 200);
}
export async function evaluate(
  questions: Corpus['questions'],
  search: (input: SearchInput) => Promise<SearchResult>,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<EvaluationRow[]> {
  const sample = sampleQuestions(questions);
  const rows: EvaluationRow[] = [];
  let done = 0;
  for (const mode of ['fulltext', 'vector', 'hybrid'] as const) {
    const row: EvaluationRow = {
      mode,
      n: sample.length,
      recall1: 0,
      recall5: 0,
      recall10: 0,
      mrr: 0,
    };
    for (const question of sample) {
      options.signal?.throwIfAborted();
      const result = await search({ query: question.question, mode, k: 10, source: 'squad' });
      options.signal?.throwIfAborted();
      const rank = result.passages.findIndex(({ id }) => id === question.passageId) + 1;
      if (rank > 0) {
        row.recall1 += Number(rank <= 1);
        row.recall5 += Number(rank <= 5);
        row.recall10 += Number(rank <= 10);
        row.mrr += 1 / rank;
      }
      options.onProgress?.(++done, sample.length * 3);
    }
    if (sample.length) {
      row.recall1 /= sample.length;
      row.recall5 /= sample.length;
      row.recall10 /= sample.length;
      row.mrr /= sample.length;
    }
    rows.push(row);
  }
  return rows;
}
