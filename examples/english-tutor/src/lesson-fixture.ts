// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { Lesson } from './schemas.js';

export const lessonFixture: Readonly<Lesson> = {
  id: 'present-simple-1',
  title: 'Present simple practice',
  grammarPoint: 'the present simple for daily routines',
  content:
    'Use the present simple for habits and routines. With he, she or it, add -s or -es: She walks to school. Use do or does for questions and negatives.',
  rubric:
    'Check that the sentence describes a habit or routine, uses the present simple, and has subject-verb agreement. Give brief English comments.',
};
