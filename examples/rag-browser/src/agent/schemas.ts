// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { galaxieField } from '@galaxie/core';
import { z } from 'zod';

export type SearchMode = 'fulltext' | 'vector' | 'hybrid';
export interface RagInput {
  question: string;
  mode: SearchMode;
  review?: boolean | undefined;
}
export interface SearchInput {
  query: string;
  mode: SearchMode;
  k: number;
}
export interface SearchResult {
  passages: { id: string; title: string; text: string; score: number }[];
}
export interface Citation {
  marker: number;
  passageId: string;
  title: string;
  text: string;
}
export interface Source {
  passageId: string;
  title: string;
  text: string;
}
export interface RagOutput {
  answer: string;
  citations: Citation[];
  /** Every passage sent to the model, so hosts can list them when no marker is cited. */
  sources: Source[];
}
const privateText = (max: number): z.ZodString =>
  z
    .string()
    .min(1)
    .max(max)
    .meta(galaxieField({ label: 'private-user', shape: 'freeText' }));
const mode = z.enum(['fulltext', 'vector', 'hybrid']).meta(galaxieField({ shape: 'enum' }));
export const RagInputSchema: z.ZodType<RagInput, RagInput> = z.strictObject({
  question: privateText(4000),
  mode,
  review: z.boolean().optional(),
});
export interface ReviewPassagesProps {
  passages: { id: string; title: string }[];
}
export interface ReviewSubmission {
  keptIds: string[];
}
export const ReviewPassagesSchema: z.ZodType<ReviewPassagesProps, ReviewPassagesProps> = z
  .strictObject({
    passages: z.array(z.strictObject({ id: privateText(200), title: z.string().max(200) })).max(10),
  })
  .meta(galaxieField({ label: 'private-user' }));
export const ReviewSubmissionSchema: z.ZodType<ReviewSubmission, ReviewSubmission> = z
  .strictObject({
    keptIds: z.array(privateText(200)).max(10),
  })
  .meta(galaxieField({ label: 'private-user' }));
export const SearchInputSchema: z.ZodType<SearchInput, SearchInput> = z.strictObject({
  query: privateText(4000),
  mode,
  k: z.number().int().min(1).max(10),
});
export const SearchResultSchema: z.ZodType<SearchResult, SearchResult> = z
  .strictObject({
    passages: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(200),
          title: z.string().max(200),
          text: privateText(4000),
          score: z.number().finite(),
        }),
      )
      .max(10),
  })
  .meta(galaxieField({ label: 'private-user' }));
export const RagOutputSchema: z.ZodType<RagOutput, RagOutput> = z.strictObject({
  answer: z.string(),
  citations: z
    .array(
      z.strictObject({
        marker: z.number().int().min(1).max(10),
        passageId: z.string(),
        title: z.string(),
        text: z.string(),
      }),
    )
    .max(10),
  sources: z
    .array(z.strictObject({ passageId: z.string(), title: z.string(), text: z.string() }))
    .max(10),
});
