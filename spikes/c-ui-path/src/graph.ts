// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type LangGraphAgent, requestInteraction } from '@galaxie/adapter-langgraph';
import { defineAgentDefinition, type Submission, type ViewRevision } from '@galaxie/core';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { z } from 'zod';

export const GENERATION_KEY = 'spike-c-generation';
export const definition = defineAgentDefinition({
  id: 'spike-c/quiz',
  version: '1.0.0',
  executor: 'langgraph-js',
  input: z.union([z.object({ topic: z.string() }), z.object({ restore: z.literal(true) })]),
  ui: { catalog: 'education/v1', components: ['Quiz'], surfaces: ['main'] },
});

export interface Question {
  id: string;
  prompt: string;
  options: string[];
}

const state = Annotation.Root({
  questions: Annotation<Question[]>,
  answerKey: Annotation<{ marker: string; answers: Record<string, string> }>,
  submission: Annotation<Submission>,
  score: Annotation<number>,
});

export function quizGraph(urlVariant: boolean): LangGraphAgent {
  return (host) =>
    new StateGraph(state)
      .addNode('generate', () => {
        sessionStorage.setItem(
          GENERATION_KEY,
          String(Number(sessionStorage.getItem(GENERATION_KEY) ?? 0) + 1),
        );
        return {
          questions: [
            {
              id: 'q1',
              prompt: urlVariant ? 'https://evil.example/x' : 'Choose the past tense of walk.',
              options: ['walked', 'walking', 'walks'],
            },
            { id: 'q2', prompt: 'Choose a plural noun.', options: ['book', 'books', 'booking'] },
            { id: 'q3', prompt: 'Choose an adjective.', options: ['quickly', 'run', 'bright'] },
          ],
          answerKey: {
            marker: 'spike-c-key-canary-7f42',
            answers: { q1: 'walked', q2: 'books', q3: 'bright' },
          },
        };
      })
      .addNode('ask', async (value, config) => {
        await Promise.resolve();
        const submission = await requestInteraction(
          {
            surfaceId: 'main',
            viewRevision: 'quiz-1' as ViewRevision,
            component: 'education.Quiz/v1',
            props: { questions: value.questions },
          },
          config,
        );
        return { submission };
      })
      .addNode('grade', (value) => {
        const payload = z
          .object({ answers: z.record(z.string(), z.string()) })
          .parse(value.submission.payload);
        return {
          score: Object.entries(value.answerKey.answers).filter(
            ([id, answer]) => payload.answers[id] === answer,
          ).length,
        };
      })
      .addEdge(START, 'generate')
      .addEdge('generate', 'ask')
      .addEdge('ask', 'grade')
      .addEdge('grade', END)
      .compile({ checkpointer: host.langchain.checkpointer() });
}
