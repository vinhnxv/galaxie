// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { convertSquad, parseCorpus, squadSource, verifySource } from '../src/corpus.js';
import fixture from './fixtures/corpus.json' with { type: 'json' };

describe('corpus', () => {
  it('deduplicates contexts and preserves questions and answer order', () => {
    const paragraph = {
      context: 'An original context.',
      qas: [
        {
          id: 'q1',
          question: 'Where?',
          answers: [{ text: 'Here' }, { text: 'Here' }, { text: 'There' }],
        },
      ],
    };
    const result = convertSquad({
      version: '1.1',
      data: [
        {
          title: 'Title',
          paragraphs: [paragraph, { ...paragraph, qas: [{ ...paragraph.qas[0], id: 'q2' }] }],
        },
      ],
    });
    expect(result.passages).toEqual([
      { id: 'squad-0-0', title: 'Title', text: 'An original context.' },
    ]);
    expect(result.questions.map((q) => q.passageId)).toEqual(['squad-0-0', 'squad-0-0']);
    expect(result.questions[0]?.answers).toEqual(['Here', 'Here', 'There']);
  });
  it('rejects a wrong digest with a fixed error', async () => {
    await expect(verifySource(new Uint8Array(squadSource.bytes))).rejects.toThrow(
      'The corpus source failed verification.',
    );
  });
  it('parses the synthetic fixture and requires its notices', () => {
    expect(parseCorpus(fixture).passages).toHaveLength(12);
    expect(parseCorpus(fixture).questions).toHaveLength(10);
    expect(() => parseCorpus({ ...fixture, license: undefined })).toThrow('The corpus is invalid.');
    expect(() => parseCorpus({ ...fixture, attribution: undefined })).toThrow(
      'The corpus is invalid.',
    );
  });
});
