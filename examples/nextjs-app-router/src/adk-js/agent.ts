// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type AdkAgent, defineAdkEntry } from '@galaxie-ai/adapter-adk';
import { type AgentDefinition, defineAgentDefinition, GalaxieError } from '@galaxie-ai/core';
import { LlmAgent } from '@google/adk';
import { z } from 'zod';

const inputSchema: z.ZodType<{ prompt: string }, { prompt: string }> = z.strictObject({
  prompt: z.string().min(1),
});
interface TemplateDefinition extends AgentDefinition {
  readonly input: typeof inputSchema;
}
export const templateDefinition: TemplateDefinition = defineAgentDefinition({
  id: 'local-only.starter',
  version: '0.0.0',
  executor: 'adk-js',
  input: inputSchema,
  models: { comment: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  capabilities: {
    required: {
      'question.ask@1': {
        kind: 'read',
        input: z.strictObject({ message: z.string() }),
        output: z.strictObject({ pending: z.boolean() }),
      },
    },
  },
  ui: { catalog: 'education/v1', components: ['Quiz'], surfaces: ['question'] },
});
export const commentPrompt = 'Give one short encouraging sentence about practicing.';

export function createTemplateAgent(): AdkAgent {
  return (host) =>
    defineAdkEntry({
      agent: new LlmAgent({
        name: 'starter',
        model: host.adk.llm('comment'),
        tools: [
          host.adk.capabilityTool('question.ask@1', {
            toolName: 'ask_question',
            description: 'Ask the practice question.',
            parameters: z.object({ message: z.string() }),
            longRunning: true,
          }),
        ],
        beforeModelCallback: ({ context, request }) => {
          if (context.state.get('starter_asked') === true) {
            // The closing comment is text-only, matching the kind's model providers and gateway.
            request.contents = [{ role: 'user', parts: [{ text: commentPrompt }] }];
            request.toolsDict = {};
            if (request.config !== undefined) request.config.tools = [];
            return undefined;
          }
          context.state.update({ starter_asked: true });
          return {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'starter-question',
                    name: 'ask_question',
                    args: { message: 'What is 2 + 2?' },
                  },
                },
              ],
            },
          };
        },
      }),
      interaction() {
        return {
          surfaceId: 'question',
          component: 'education.Quiz/v1',
          viewRevision: 'question-v1',
          props: {
            title: 'A tiny local agent',
            questions: [
              {
                id: 'sum',
                prompt: 'What is 2 + 2?',
                options: [
                  { id: 'four', label: '4' },
                  { id: 'five', label: '5' },
                ],
              },
            ],
          },
        };
      },
      resume(requests, action, payload) {
        const answer = z
          .strictObject({ answers: z.strictObject({ sum: z.enum(['four', 'five']) }) })
          .safeParse(payload);
        if (action !== 'submit' || !answer.success)
          throw new GalaxieError('invalid', 'The quiz answer must be valid.');
        return requests.map(() => ({
          response: { grade: answer.data.answers.sum === 'four' ? 'Correct.' : 'The answer is 4.' },
        }));
      },
    });
}
