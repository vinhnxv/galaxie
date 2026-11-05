// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

export const squadSource: { url: string; bytes: number; sha256: string } = {
  url: 'https://rajpurkar.github.io/SQuAD-explorer/dataset/dev-v1.1.json',
  bytes: 4854279,
  sha256: '95aa6a52d5d6a735563366753ca50492a658031da74f301ac5238b03966972c9',
};
export const attribution: string = 'SQuAD v1.1, Rajpurkar et al. (2016), CC BY-SA 4.0.';
export interface Passage {
  id: string;
  title: string;
  text: string;
}
export interface Corpus {
  format: 'galaxie.rag-corpus/v1';
  license: string;
  attribution: string;
  source: { url: string; sha256: string };
  passages: Passage[];
  questions: { id: string; question: string; answers: string[]; passageId: string }[];
}
const passage = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  text: z.string().min(1),
});
export const CorpusSchema: z.ZodType<Corpus, Corpus> = z.strictObject({
  format: z.literal('galaxie.rag-corpus/v1'),
  license: z.string().min(1),
  attribution: z.string().min(1),
  source: z.strictObject({ url: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  passages: z.array(passage),
  questions: z.array(
    z.strictObject({
      id: z.string(),
      question: z.string(),
      answers: z.array(z.string()),
      passageId: z.string(),
    }),
  ),
});

export function parseCorpus(value: unknown): Corpus {
  const result = CorpusSchema.safeParse(value);
  if (!result.success) throw new Error('The corpus is invalid.');
  return result.data;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifySource(bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength !== squadSource.bytes || (await sha256(bytes)) !== squadSource.sha256)
    throw new Error('The corpus source failed verification.');
}

const SquadSchema = z.object({
  version: z.literal('1.1'),
  data: z.array(
    z.object({
      title: z.string(),
      paragraphs: z.array(
        z.object({
          context: z.string().min(1),
          qas: z.array(
            z.object({
              id: z.string(),
              question: z.string(),
              answers: z.array(z.object({ text: z.string() })),
            }),
          ),
        }),
      ),
    }),
  ),
});

export function convertSquad(value: unknown): Corpus {
  const parsed = SquadSchema.safeParse(value);
  if (!parsed.success) throw new Error('The corpus source is invalid.');
  const passages: Corpus['passages'] = [];
  const questions: Corpus['questions'] = [];
  const contexts = new Map<string, string>();
  parsed.data.data.forEach((article, articleIndex) => {
    article.paragraphs.forEach((paragraph, paragraphIndex) => {
      let id = contexts.get(paragraph.context);
      if (id === undefined) {
        id = `squad-${articleIndex}-${paragraphIndex}`;
        contexts.set(paragraph.context, id);
        passages.push({ id, title: article.title, text: paragraph.context });
      }
      for (const question of paragraph.qas)
        questions.push({
          id: question.id,
          question: question.question,
          answers: question.answers.map(({ text }) => text),
          passageId: id,
        });
    });
  });
  return {
    format: 'galaxie.rag-corpus/v1',
    license: 'CC BY-SA 4.0',
    attribution,
    source: { url: squadSource.url, sha256: squadSource.sha256 },
    passages,
    questions,
  };
}
