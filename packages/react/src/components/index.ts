// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { Feedback } from './feedback.js';
import { Progress } from './progress.js';
import { Quiz } from './quiz.js';
import { WritingPrompt } from './writing-prompt.js';

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

export {
  WritingPrompt,
  type WritingPromptActions,
  type WritingPromptProps,
  type WritingSubmission,
} from './writing-prompt.js';

export const educationComponents: readonly [
  typeof Quiz,
  typeof Feedback,
  typeof Progress,
  typeof WritingPrompt,
] = [Quiz, Feedback, Progress, WritingPrompt];
