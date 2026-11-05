// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Deliberate copy: the Vite config bundle must not resolve workspace dist imports.
export const lesson = {
  id: 'present-simple-1',
  title: 'Present simple practice',
  grammarPoint: 'the present simple for daily routines',
  content:
    'Use the present simple for habits and routines. With he, she or it, add -s or -es: She walks to school. Use do or does for questions and negatives.',
  rubric:
    'Check that the sentence describes a habit or routine, uses the present simple, and has subject-verb agreement. Give brief English comments.',
};

export const quiz: {
  questions: {
    prompt: string;
    options: { id: string; label: string }[];
    correctOptionId: string;
  }[];
} = {
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
