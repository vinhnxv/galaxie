// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { parseCorpus } from '../src/corpus.js';
import { RetrievalIndex, tokenize } from '../src/retrieval/index.js';
import { createMockEmbedder } from '../src/retrieval/mock-embedder.js';
import { parseMessage } from '../src/retrieval/protocol.js';
import fixture from './fixtures/corpus.json' with { type: 'json' };

test('indexes Unicode, ranks all search modes and round-trips Orama vectors', async () => {
  const corpus = parseCorpus(fixture);
  const index = new RetrievalIndex(createMockEmbedder());
  await index.add(corpus.passages.map((passage) => ({ ...passage, source: 'squad' as const })));
  expect(tokenize('café naïve')).toEqual(['café', 'naïve']);
  expect((await index.search({ query: 'café', mode: 'fulltext', k: 5 })).passages[0]?.id).toBe(
    'p4',
  );
  const modes = ['fulltext', 'vector', 'hybrid'] as const;
  for (const mode of modes) {
    const results = await index.search({ query: 'capital of France', mode, k: 10 });
    expect(results.passages[0]?.id).toBe('p1');
    if (mode === 'vector') expect(results.passages.find(({ id }) => id === 'p10')).toBeUndefined();
    const restored = new RetrievalIndex(createMockEmbedder(), index.save());
    expect(await restored.search({ query: 'capital of France', mode, k: 10 })).toEqual(results);
  }
  expect(
    (await index.search({ query: 'Cities', mode: 'fulltext', k: 10 })).passages.map(
      ({ title }) => title,
    ),
  ).toEqual(['Cities', 'Cities', 'Cities', 'Cities']);
});

test('source filters exclude pasted text in every mode', async () => {
  const index = new RetrievalIndex(createMockEmbedder());
  await index.add([
    { id: 'squad', title: 'Moon', text: 'moon', source: 'squad' },
    { id: 'paste', title: 'none', text: 'moon moon', source: 'pasted' },
  ]);
  for (const mode of ['fulltext', 'vector', 'hybrid'] as const)
    expect(
      (await index.search({ query: 'moon', mode, k: 10, source: 'squad' })).passages.map(
        ({ id }) => id,
      ),
    ).toEqual(['squad']);
});

test('hybrid ranks the lexical and vector match above a vector-only match', async () => {
  const embedder = createMockEmbedder();
  const [matching] = await embedder.embed(['moon'], 'query');
  const index = new RetrievalIndex({
    ...embedder,
    embed: async (texts) => texts.map(() => matching ?? []),
  });
  await index.add([
    { id: 'both', title: 'Moon', text: 'moon', source: 'squad' },
    { id: 'vector', title: 'Other', text: 'unrelated', source: 'squad' },
  ]);
  expect(
    (await index.search({ query: 'moon', mode: 'hybrid', k: 10 })).passages.map(({ id }) => id),
  ).toEqual(['both', 'vector']);
});

test('protocol rejects unknown, malformed and oversized messages without content', () => {
  for (const value of [
    { id: 1, type: 'unknown' },
    { id: 1, type: 'search', query: 'x', mode: 'vector', k: 11 },
    { id: 1, type: 'search', query: 'secret'.repeat(200000), mode: 'fulltext', k: 1 },
  ])
    expect(() => parseMessage(value)).toThrow('The retrieval message is invalid.');
});

test('enforces k and byte limits on otherwise valid message envelopes', () => {
  expect(
    parseMessage({ id: 1, type: 'search', input: { query: 'moon', mode: 'vector', k: 10 } }),
  ).toEqual({ id: 1, type: 'search', input: { query: 'moon', mode: 'vector', k: 10 } });
  expect(() =>
    parseMessage({ id: 1, type: 'search', input: { query: 'moon', mode: 'vector', k: 11 } }),
  ).toThrow('The retrieval message is invalid.');
  const corpus = {
    ...fixture,
    passages: [{ id: 'large', title: 'Large', text: 'x'.repeat(1000000) }],
    questions: [],
  };
  expect(parseCorpus(corpus).passages).toHaveLength(1);
  expect(() =>
    parseMessage({ id: 1, type: 'init', input: { appId: 'test', mock: true, corpus } }),
  ).toThrow('The retrieval message is invalid.');
});
