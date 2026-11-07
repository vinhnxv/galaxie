// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { type Corpus, CorpusSchema } from '../corpus.js';

export const messageLimit: number = 1000000;
export const invalidMessage: string = 'The retrieval message is invalid.';
export type SearchMode = 'fulltext' | 'vector' | 'hybrid';
export const SearchModeSchema: z.ZodType<SearchMode, SearchMode> = z.enum([
  'fulltext',
  'vector',
  'hybrid',
]);

export interface SearchInput {
  query: string;
  mode: SearchMode;
  k: number;
  source?: 'squad' | 'pasted' | undefined;
}
export const SearchInputSchema: z.ZodType<SearchInput, SearchInput> = z.strictObject({
  query: z.string().min(1).max(4000),
  mode: SearchModeSchema,
  k: z.number().int().min(1).max(10),
  source: z.enum(['squad', 'pasted']).optional(),
});

export interface SearchResult {
  passages: { id: string; title: string; text: string; score: number }[];
}
export const SearchResultSchema: z.ZodType<SearchResult, SearchResult> = z.strictObject({
  passages: z
    .array(
      z.strictObject({
        id: z.string().max(200),
        title: z.string().max(200),
        text: z.string().max(4000),
        score: z.number().finite(),
      }),
    )
    .max(10),
});

export interface InitInput {
  appId: string;
  principalScope: string;
  mock: boolean;
  corpus?: Corpus | null | undefined;
  corpusUrl?: '/data/squad-dev.json' | undefined;
}
export const InitInputSchema: z.ZodType<InitInput, InitInput> = z
  .strictObject({
    appId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    principalScope: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    mock: z.boolean(),
    corpus: CorpusSchema.nullable().optional(),
    corpusUrl: z.literal('/data/squad-dev.json').optional(),
  })
  .refine((value) => !(value.corpus && value.corpusUrl));

const id = z.number().int().nonnegative();
export type RetrievalMessage =
  | { id: number; type: 'init'; input: InitInput }
  | { id: number; type: 'consent' | 'clear' | 'remove-model' }
  | { id: number; type: 'paste'; text: string }
  | { id: number; type: 'search'; input: SearchInput };
const MessageSchema: z.ZodType<RetrievalMessage, RetrievalMessage> = z.discriminatedUnion('type', [
  z.strictObject({ id, type: z.literal('init'), input: InitInputSchema }),
  z.strictObject({ id, type: z.literal('consent') }),
  z.strictObject({ id, type: z.literal('paste'), text: z.string().max(200000) }),
  z.strictObject({ id, type: z.literal('search'), input: SearchInputSchema }),
  z.strictObject({ id, type: z.literal('clear') }),
  z.strictObject({ id, type: z.literal('remove-model') }),
]);

export interface RetrievalSnapshot {
  status: 'empty' | 'awaiting-consent' | 'downloading' | 'building' | 'ready' | 'failed';
  count: number;
  pastedCount: number;
  restored: boolean;
  device: 'mock' | 'webgpu' | null;
  loaded: number;
  total: number;
  added: number;
  message: string | null;
  corpusMissing: boolean;
}
export const SnapshotSchema: z.ZodType<RetrievalSnapshot, RetrievalSnapshot> = z.strictObject({
  status: z.enum(['empty', 'awaiting-consent', 'downloading', 'building', 'ready', 'failed']),
  count: z.number().int().nonnegative(),
  pastedCount: z.number().int().nonnegative(),
  restored: z.boolean(),
  device: z.enum(['mock', 'webgpu']).nullable(),
  loaded: z.number().nonnegative(),
  total: z.number().nonnegative(),
  added: z.number().int().nonnegative(),
  message: z.string().max(200).nullable(),
  corpusMissing: z.boolean(),
});

export const emptySnapshot: RetrievalSnapshot = {
  status: 'empty',
  count: 0,
  pastedCount: 0,
  restored: false,
  device: null,
  loaded: 0,
  total: 0,
  added: 0,
  message: null,
  corpusMissing: false,
};
export type RetrievalEvent =
  | { type: 'progress' | 'ready'; snapshot: RetrievalSnapshot }
  | { type: 'failed'; id: number; message: string; snapshot: RetrievalSnapshot }
  | { type: 'result'; id: number; result: RetrievalSnapshot | SearchResult };
const EventSchema: z.ZodType<RetrievalEvent, RetrievalEvent> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('progress'), snapshot: SnapshotSchema }),
  z.strictObject({ type: z.literal('ready'), snapshot: SnapshotSchema }),
  z.strictObject({
    type: z.literal('failed'),
    id,
    message: z.string().max(200),
    snapshot: SnapshotSchema,
  }),
  z.strictObject({
    type: z.literal('result'),
    id,
    result: z.union([SnapshotSchema, SearchResultSchema]),
  }),
]);

function withinLimit(value: unknown): void {
  try {
    const json = JSON.stringify(value);
    if (json === undefined || new TextEncoder().encode(json).byteLength > messageLimit)
      throw new Error();
  } catch {
    throw new Error(invalidMessage);
  }
}
export function parseMessage(value: unknown): RetrievalMessage {
  withinLimit(value);
  const parsed = MessageSchema.safeParse(value);
  if (!parsed.success) throw new Error(invalidMessage);
  return parsed.data;
}
export function parseEvent(value: unknown): RetrievalEvent {
  withinLimit(value);
  const parsed = EventSchema.safeParse(value);
  if (!parsed.success) throw new Error(invalidMessage);
  return parsed.data;
}
