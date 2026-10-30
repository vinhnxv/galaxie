// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { count, create, insert, load, type Orama, type RawData, save, search } from '@orama/orama';
import type { Passage } from '../corpus.js';
import type { Embedder } from './embedder.js';
import type { SearchInput, SearchResult } from './protocol.js';
import { embeddingSettings } from './settings.js';

export interface IndexedPassage extends Passage {
  readonly source: 'squad' | 'pasted';
}
const schema = {
  id: 'string',
  title: 'string',
  text: 'string',
  source: 'string',
  embedding: 'vector[256]',
} as const;
// The synthetic fixture's relevant mock cosine is 0.408248; unrelated passages score
// below 0.2. This explicit cutoff preserves those hits, unlike Orama's 0.8 default.
// Real EmbeddingGemma retrieval quality remains unmeasured.
export const vectorSimilarity: number = 0.2;
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
export class RetrievalIndex {
  private readonly database: Orama<typeof schema>;
  private readonly embedder: Embedder;
  constructor(embedder: Embedder, saved?: RawData) {
    this.embedder = embedder;
    this.database = create({
      schema,
      components: { tokenizer: { language: 'english', normalizationCache: new Map(), tokenize } },
    });
    if (saved) load(this.database, saved);
  }
  get count(): number {
    return count(this.database);
  }
  async add(
    passages: readonly IndexedPassage[],
    progress: (loaded: number, total: number) => void = () => {},
  ): Promise<void> {
    for (let offset = 0; offset < passages.length; offset += embeddingSettings.batchSize) {
      const batch = passages.slice(offset, offset + embeddingSettings.batchSize);
      const vectors = await this.embedder.embed(
        batch.map((passage) =>
          embeddingSettings.passagePrefix.replace(/<title>|<text>/g, (field) =>
            field === '<title>'
              ? passage.source === 'pasted'
                ? 'none'
                : passage.title
              : passage.text,
          ),
        ),
        'passage',
      );
      for (let index = 0; index < batch.length; index++) {
        const passage = batch[index];
        const vector = vectors[index];
        if (!passage || !vector || vector.length !== embeddingSettings.dimensions)
          throw new Error('The embedding result is invalid.');
        await insert(this.database, { ...passage, embedding: vector });
      }
      progress(Math.min(offset + batch.length, passages.length), passages.length);
    }
  }
  async search(input: SearchInput): Promise<SearchResult> {
    const common = {
      limit: input.k,
      properties: ['title', 'text'] as ('title' | 'text')[],
      ...(input.source ? { where: { source: input.source } } : {}),
    };
    let result: Awaited<ReturnType<typeof search<Orama<typeof schema>>>>;
    if (input.mode === 'fulltext')
      result = await search(this.database, { ...common, term: input.query, boost: { title: 2 } });
    else {
      const [value] = await this.embedder.embed([input.query], 'query');
      if (!value) throw new Error('The embedding result is invalid.');
      const vector = { property: 'embedding' as const, value };
      result =
        input.mode === 'vector'
          ? await search(this.database, {
              ...common,
              mode: 'vector',
              vector,
              similarity: vectorSimilarity,
            })
          : await search(this.database, {
              ...common,
              mode: 'hybrid',
              term: input.query,
              vector,
              similarity: vectorSimilarity,
              hybridWeights: { text: 0.5, vector: 0.5 },
              boost: { title: 2 },
            });
    }
    return {
      passages: result.hits.map(({ document, score }) => ({
        id: document.id.slice(0, 200),
        title: document.title.slice(0, 200),
        text: document.text.slice(0, 4000),
        score,
      })),
    };
  }
  save(): RawData {
    return save(this.database);
  }
}
