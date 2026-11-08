// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { galaxieField } from '@galaxie-ai/core';
import { z } from 'zod';

const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .max(64)
  .meta(galaxieField({ shape: 'id' }));
const publicText = (max: number): z.ZodString =>
  z
    .string()
    .min(1)
    .max(max)
    .meta(galaxieField({ label: 'public', shape: 'freeText' }));

export interface TutorInput {
  lessonId: string;
}
export interface Lesson {
  id: string;
  title: string;
  grammarPoint: string;
  content: string;
  rubric: string;
}
export interface ProgressInput {
  lessonId: string;
  score: number;
  total: number;
}
export interface ProgressOutput {
  saved: true;
}
export interface TutorOutput extends ProgressInput, ProgressOutput {}
export interface QuizDraft {
  questions: {
    prompt: string;
    options: { id: string; label: string }[];
    correctOptionId: string;
  }[];
}
export interface Review {
  verdict: 'correct' | 'needs_work';
  comments: string[];
}

export const LessonInputSchema: z.ZodType<TutorInput, TutorInput> = z.strictObject({
  lessonId: idSchema,
});
export const TutorInputSchema: typeof LessonInputSchema = LessonInputSchema;
export const LessonSchema: z.ZodType<Lesson, Lesson> = z
  .strictObject({
    id: idSchema,
    title: publicText(200),
    grammarPoint: publicText(500),
    content: publicText(4000),
    rubric: publicText(2000),
  })
  .meta(galaxieField({ label: 'public' }));
export const ProgressInputSchema: z.ZodType<ProgressInput, ProgressInput> = z
  .strictObject({
    lessonId: idSchema,
    score: z.number().int().min(0).max(20),
    total: z.number().int().min(0).max(20),
  })
  .refine(({ score, total }) => score <= total);
export const ProgressOutputSchema: z.ZodType<ProgressOutput, ProgressOutput> = z.strictObject({
  saved: z.literal(true),
});
export const QuizDraftSchema: z.ZodType<QuizDraft, QuizDraft> = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        prompt: z.string().min(1).max(1700),
        options: z
          .array(z.strictObject({ id: idSchema, label: z.string().min(1).max(200) }))
          .min(3)
          .max(4)
          .refine((options) => new Set(options.map(({ id }) => id)).size === options.length),
        correctOptionId: idSchema,
      }),
    )
    .min(3)
    .max(5),
});
export const ReviewSchema: z.ZodType<Review, Review> = z.strictObject({
  verdict: z.enum(['correct', 'needs_work']),
  comments: z.array(z.string().min(1).max(300)).min(1).max(3),
});
