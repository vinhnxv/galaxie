// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type AgentDefinition,
  type CapabilityRequest,
  defineAgentDefinition,
} from '@galaxie-ai/core';
import {
  LessonInputSchema,
  LessonSchema,
  ProgressInputSchema,
  ProgressOutputSchema,
  TutorInputSchema,
} from './schemas.js';

export interface TutorDefinition extends AgentDefinition {
  readonly input: typeof TutorInputSchema;
  readonly capabilities: {
    readonly required: {
      readonly 'lessons.get@1': CapabilityRequest<typeof LessonInputSchema, typeof LessonSchema>;
      readonly 'progress.save@1': CapabilityRequest<
        typeof ProgressInputSchema,
        typeof ProgressOutputSchema
      >;
    };
  };
}

export const tutorDefinition: TutorDefinition = defineAgentDefinition({
  id: 'galaxie.english-tutor',
  version: '0.0.0',
  executor: 'langgraph-js',
  input: TutorInputSchema,
  capabilities: {
    required: {
      'lessons.get@1': { kind: 'read', input: LessonInputSchema, output: LessonSchema },
      'progress.save@1': {
        kind: 'write',
        input: ProgressInputSchema,
        output: ProgressOutputSchema,
      },
    },
  },
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
