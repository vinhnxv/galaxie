// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type LangGraphAgent, requestInteraction } from '@galaxie/adapter-langgraph';
import { type AgentDefinition, defineAgentDefinition } from '@galaxie/core';
import type { QuizSubmission } from '@galaxie/react';
import { HumanMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { z } from 'zod';

const inputSchema: z.ZodType<Record<string, never>, Record<string, never>> = z.strictObject({});

interface TemplateDefinition extends AgentDefinition {
  readonly input: typeof inputSchema;
}

export const templateDefinition: TemplateDefinition = defineAgentDefinition({
  id: 'local-only.starter',
  version: '0.0.0',
  executor: 'langgraph-js',
  input: inputSchema,
  models: {
    comment: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' },
  },
  ui: { catalog: 'education/v1', components: ['Quiz'], surfaces: ['question'] },
});

export const commentPrompt = 'Give one short encouraging sentence about practicing.';

const state = Annotation.Root({ result: Annotation<string> });

/** The interrupt precedes the model call, so restoring the question repeats no inference. */
export function createTemplateAgent(): LangGraphAgent {
  return (host) =>
    new StateGraph(state)
      .addNode('question', async (_state, config) => {
        const submission = requestInteraction(
          {
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
          },
          config,
        );
        const { answers } = submission.payload as QuizSubmission;
        const reply = await host.langchain
          .chatModel('comment')
          .invoke([new HumanMessage(commentPrompt)], config);
        const grade = answers['sum'] === 'four' ? 'Correct.' : 'The answer is 4.';
        return { result: `${grade} ${reply.text}` };
      })
      .addEdge(START, 'question')
      .addEdge('question', END)
      .compile({ checkpointer: host.langchain.checkpointer() });
}
