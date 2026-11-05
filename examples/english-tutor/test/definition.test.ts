// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type BindingsFor, readAnnotations } from '@galaxie/core';
import { expect, test } from 'vitest';
import { tutorDefinition } from '../src/definition.js';
import { lessonFixture } from '../src/lesson-fixture.js';
import { LessonInputSchema, LessonSchema, ProgressInputSchema } from '../src/schemas.js';

test('the definition declares the complete host and UI contracts', () => {
  expect(tutorDefinition).toMatchObject({
    id: 'galaxie.english-tutor',
    version: '0.0.0',
    executor: 'langgraph-js',
    models: {
      'quiz.generate': { modality: 'text', requires: ['structured-output'], languages: ['en'] },
      'tutor.feedback': {
        modality: 'text',
        requires: ['structured-output'],
        languages: ['en'],
        defaultPolicy: 'local-only',
      },
    },
    ui: {
      catalog: 'education/v1',
      components: ['Quiz', 'WritingPrompt', 'Feedback', 'Progress'],
      surfaces: ['lesson-main'],
    },
  });
  expect(Object.keys(tutorDefinition.capabilities.required)).toEqual([
    'lessons.get@1',
    'progress.save@1',
  ]);
});

test('the fixture validates and lesson annotations bound host data and IDs', () => {
  expect(LessonSchema.safeParse(lessonFixture).success).toBe(true);
  const lesson = readAnnotations(LessonSchema);
  expect(lesson.properties.get('content')).toBe('freeText');
  expect(lesson.properties.get('rubric')).toBe('freeText');
  expect([...lesson.labels]).toEqual(['public']);
  expect(readAnnotations(LessonInputSchema).properties.get('lessonId')).toBe('id');
  expect(readAnnotations(tutorDefinition.input).properties.get('lessonId')).toBe('id');
  expect(LessonSchema.safeParse({ ...lessonFixture, content: 'x'.repeat(4001) }).success).toBe(
    false,
  );
  expect(LessonSchema.safeParse({ ...lessonFixture, rubric: 'x'.repeat(2001) }).success).toBe(
    false,
  );
});

test('progress arguments enforce practice-score bounds', () => {
  for (const [score, total] of [
    [-1, 3],
    [4, 3],
    [0, 21],
    [1.5, 3],
  ]) {
    expect(
      ProgressInputSchema.safeParse({ lessonId: lessonFixture.id, score, total }).success,
    ).toBe(false);
  }
  expect(
    ProgressInputSchema.safeParse({ lessonId: lessonFixture.id, score: 2, total: 3 }).success,
  ).toBe(true);
});

function checkBindings(bindings: BindingsFor<typeof tutorDefinition>): void {
  // @ts-expect-error The progress write is a required host binding.
  const missing: BindingsFor<typeof tutorDefinition> = {
    'lessons.get@1': bindings['lessons.get@1'],
  };
  void missing;
}
void checkBindings;
