// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import data from '../data/questions.json';

const common = {
  id: z.string().regex(/^[a-z0-9-]+$/),
  domain: z.enum(['tutor', 'support', 'write-confirmation', 'privacy']),
  state: z.string().min(1),
  prompt: z.string().min(1),
  split: z.enum(['calibration', 'evaluation']),
};
export const questionSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      ...common,
      type: z.literal('boolean'),
      options: z.null(),
      label: z.boolean(),
    }),
    z.strictObject({
      ...common,
      type: z.literal('choice'),
      options: z
        .record(z.string(), z.string())
        .refine((value) => Object.keys(value).length >= 3 && Object.keys(value).length <= 5),
      label: z.string(),
    }),
    z.strictObject({
      ...common,
      type: z.literal('score'),
      options: z.strictObject({
        levels: z.number().int().min(2).max(10),
        legend: z.record(z.string(), z.string()),
      }),
      label: z.number().int(),
    }),
  ])
  .refine((question) => validValue(question, question.label), 'invalid_label');
export type Question = z.infer<typeof questionSchema>;
export type Value = boolean | string | number;
export interface Answer {
  id: string;
  value: Value;
  confidence: number | null;
}

export function validValue(
  question: { type: string; options: unknown },
  value: unknown,
): value is Value {
  if (question.type === 'boolean') return typeof value === 'boolean';
  if (question.type === 'choice')
    return typeof value === 'string' && Object.hasOwn(question.options as object, value);
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= (question.options as { levels: number }).levels
  );
}
export const questions: Question[] = z.array(questionSchema).length(200).parse(data.questions);

/** Complete, atomic validation; raw reply values never enter a results export. */
export function validateAnswers(requested: readonly Question[], answers: readonly Answer[]): void {
  if (
    answers.length !== requested.length ||
    new Set(answers.map((answer) => answer.id)).size !== requested.length
  )
    throw new Error('invalid_answers');
  for (const question of requested) {
    const answer = answers.find((item) => item.id === question.id);
    if (
      !answer ||
      !validValue(question, answer.value) ||
      (answer.confidence !== null &&
        (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1))
    )
      throw new Error('invalid_answers');
  }
}
