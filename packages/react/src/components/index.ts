// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { Feedback } from './feedback.js';
import { Progress } from './progress.js';
import { Quiz } from './quiz.js';

export { Feedback, type FeedbackItem, type FeedbackProps } from './feedback.js';
export { Progress, type ProgressProps } from './progress.js';
export {
  Quiz,
  type QuizActions,
  type QuizOption,
  type QuizProps,
  type QuizQuestion,
  type QuizSubmission,
} from './quiz.js';

export const educationComponents: readonly [typeof Quiz, typeof Feedback, typeof Progress] = [
  Quiz,
  Feedback,
  Progress,
];
