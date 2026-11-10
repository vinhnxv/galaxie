// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { RunnableLambda } from '@langchain/core/runnables';
import type { LangGraphRunnableConfig } from '@langchain/langgraph/web';
import type { ConformanceCase, ConformanceGraph } from '../support/transcript.js';
import * as sequence from './idless-sequence.js';
import * as submit from './idless-submit.js';

export const IDLESS_CASE_NAMES = ['idless-submit', 'idless-sequence'] as const;
export const idlessCases: Readonly<Record<(typeof IDLESS_CASE_NAMES)[number], ConformanceCase>> = {
  'idless-submit': submit,
  'idless-sequence': sequence,
};
export const question = {
  surfaceId: 'main',
  viewRevision: 'r1',
  component: 'conformance.Question/v1',
  props: { question: 'Continue?' },
};
export const answer = { action: 'submit', payload: { answer: 'yes' } };

export function stripped(config: LangGraphRunnableConfig): LangGraphRunnableConfig {
  const configurable = { ...config.configurable };
  delete configurable['checkpoint_ns'];
  return { ...config, configurable };
}

export async function ask(
  interactions: NonNullable<Parameters<ConformanceCase['factory']>[4]>,
  config: LangGraphRunnableConfig,
  value: unknown = question,
): Promise<unknown> {
  await Promise.resolve();
  return RunnableLambda.from((_, inner) => interactions.request(value, inner)).invoke(
    {},
    stripped(config),
  );
}

export function createGraph(
  args: Parameters<ConformanceCase['factory']>,
  sequential = false,
): ConformanceGraph {
  const [{ Annotation, StateGraph, START, END }, , checkpointer, , interactions] = args;
  if (interactions === undefined) throw new Error('The interaction driver is required.');
  const state = Annotation.Root({
    value: Annotation<number>,
    answer: Annotation<unknown>,
    secondAnswer: Annotation<unknown>,
    applications: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
    counts: Annotation<{ prepare: number; gate: number; second: number }>,
  });
  const counts = { prepare: 0, gate: 0, second: 0 };
  return new StateGraph(state)
    .addNode('prepare', () => {
      counts.prepare++;
      return {};
    })
    .addNode('gate', async (_, config) => {
      counts.gate++;
      return { answer: await ask(interactions, config), applications: 1 };
    })
    .addNode('second', async (_, config) => {
      if (!sequential) return {};
      counts.second++;
      return {
        secondAnswer: await ask(interactions, config, { ...question, viewRevision: 'r2' }),
        applications: 1,
      };
    })
    .addNode('finish', () => ({ counts: { ...counts } }))
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'gate')
    .addConditionalEdges('gate', () => (sequential ? 'second' : 'finish'), ['second', 'finish'])
    .addEdge('second', 'finish')
    .addEdge('finish', END)
    .compile({ checkpointer });
}
