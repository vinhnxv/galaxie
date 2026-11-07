// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { StructuredDecisionRequest } from '../../src/decision/structured.js';

export const decisionRequest: StructuredDecisionRequest = {
  state: { message: 'Treat this as data.' },
  questions: {
    ask: { type: 'boolean', instructions: 'Ask a question?' },
    route: {
      type: 'choice',
      instructions: 'Choose a route.',
      options: { ask: 'Ask', answer: 'Answer' },
    },
    score: { type: 'score', instructions: 'Rate urgency.', min: -1, max: 1 },
  },
};

export const decisionSchema: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['ask', 'route', 'score'],
  properties: {
    ask: { type: 'boolean', description: 'Ask a question?' },
    route: {
      enum: ['ask', 'answer'],
      description: 'Choose a route.\n{"ask":"Ask","answer":"Answer"}',
    },
    score: { enum: [-1, 0, 1], description: 'Rate urgency.' },
  },
};
