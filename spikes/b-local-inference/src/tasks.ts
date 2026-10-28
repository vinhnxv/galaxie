// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { JsonSchema, Message } from './arms/types.js';
export const quizSchema = z.object({
  questions: z
    .array(
      z.object({
        prompt: z.string().min(1),
        options: z.array(z.string().min(1)).length(3),
        answer: z.enum(['A', 'B', 'C']),
      }),
    )
    .length(3),
});
export const codeWord = 'zq-violet-7';
export const probeSchema = z.strictObject({ code: z.enum([codeWord]) });
export const coverageSchema = z.object({
  count: z.number(),
  enabled: z.boolean(),
  optional: z.string().optional(),
  choice: z.union([z.string(), z.number()]),
});
export interface Task {
  id: 'quiz' | 'feedback-en' | 'feedback-vi';
  messages: Message[];
  maxTokens: number;
  schema?: JsonSchema;
  valid(text: string): boolean | null;
}
export function validates(schema: z.ZodType, text: string): boolean {
  try {
    return schema.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}
export const tasks: Task[] = [
  {
    id: 'quiz',
    messages: [
      {
        role: 'system',
        content: 'You teach English. Return only JSON matching the supplied schema.',
      },
      {
        role: 'user',
        content:
          'Write exactly three multiple-choice questions on English past tense. Each has three options and an answer A, B, or C.',
      },
    ],
    maxTokens: 512,
    schema: z.toJSONSchema(quizSchema),
    valid: (text) => validates(quizSchema, text),
  },
  {
    id: 'feedback-en',
    messages: [
      {
        role: 'user',
        content:
          'Give two or three sentences of feedback in English on this learner sentence: Yesterday I go to school.',
      },
    ],
    maxTokens: 160,
    valid: () => null,
  },
  {
    id: 'feedback-vi',
    messages: [
      {
        role: 'user',
        content:
          'Give two or three sentences of feedback in Vietnamese on this learner sentence: Yesterday I go to school.',
      },
    ],
    maxTokens: 160,
    valid: () => null,
  },
];
export const schemaProbe = {
  messages: [
    {
      role: 'user',
      content: 'Give a one-sentence prose answer about the weather. Do not use JSON.',
    } satisfies Message,
  ],
  schema: z.toJSONSchema(probeSchema),
  maxTokens: 64,
};
export const schemaCoverage = {
  messages: [
    {
      role: 'user',
      content: 'Return one value matching the supplied JSON Schema.',
    } satisfies Message,
  ],
  schema: z.toJSONSchema(coverageSchema),
  maxTokens: 160,
};
export const resetRemember: Message[] = [
  { role: 'user', content: `Remember the code word ${codeWord}.` },
];
export const resetRecall: Message[] = [
  { role: 'user', content: 'What code word did I tell you? If none, say unknown.' },
];
