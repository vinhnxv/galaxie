// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { lessonFixture, type QuizDraft, type Review } from '@galaxie-ai/example-english-tutor';
import { MockChatModel } from '@galaxie-ai/models/mock';
import { type LocalModels, localDescriptor } from './runtime.js';

export const sentinelSentence = 'Galaxie sentinel 7f3e she walk to school';

export const quizReply: QuizDraft = {
  questions: [
    {
      prompt: 'She ___ to school every day.',
      options: [
        { id: 'walk', label: 'walk' },
        { id: 'walks', label: 'walks' },
        { id: 'walking', label: 'walking' },
      ],
      correctOptionId: 'walks',
    },
    {
      prompt: 'They ___ football on Sundays.',
      options: [
        { id: 'play', label: 'play' },
        { id: 'plays', label: 'plays' },
        { id: 'playing', label: 'playing' },
      ],
      correctOptionId: 'play',
    },
    {
      prompt: 'He ___ coffee in the morning.',
      options: [
        { id: 'drink', label: 'drink' },
        { id: 'drinking', label: 'drinking' },
        { id: 'drinks', label: 'drinks' },
      ],
      correctOptionId: 'drinks',
    },
  ],
};

export const reviewReply: Review = {
  verdict: 'needs_work',
  comments: ['Use walks with she: She walks to school.'],
};

export function createMockModels(): LocalModels {
  const quiz = new MockChatModel({
    [JSON.stringify({ content: lessonFixture.content, grammarPoint: lessonFixture.grammarPoint })]:
      { id: 'local-quiz', text: JSON.stringify(quizReply) },
  });
  const review = new MockChatModel({
    [JSON.stringify({
      rubric: lessonFixture.rubric,
      grammarPoint: lessonFixture.grammarPoint,
      sentence: sentinelSentence,
    })]: { id: 'local-review', text: JSON.stringify(reviewReply) },
  });
  return {
    chatModels: { quiz, review },
    routing: {
      providers: { quiz: localDescriptor, review: localDescriptor },
      roles: {
        'quiz.generate': { providers: ['quiz'], allow: ['in-browser'], maxTokens: 2000 },
        'tutor.feedback': { providers: ['review'], allow: ['in-browser'], maxTokens: 1000 },
      },
    },
  };
}
