// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConformanceCase, ConformanceGraph } from '../support/transcript.js';

export const input = { value: 1 };
export const script = {};
export const resumes = [{ action: 'submit', payload: { answer: 'yes' } }] as const;

export const request = {
  surfaceId: 'main',
  viewRevision: 'r1',
  component: 'conformance.Question/v1',
  props: { question: 'Continue?' },
};

export function createGraph(
  args: Parameters<ConformanceCase['factory']>,
  durability?: 'sync' | 'exit',
): ConformanceGraph {
  const [langgraph, , checkpointer, , interactions] = args;
  if (interactions === undefined) throw new Error('The interaction driver is required.');
  const { Annotation, StateGraph, START, END } = langgraph;
  const state = Annotation.Root({
    value: Annotation<number>,
    answer: Annotation<unknown>,
    counts: Annotation<{ prepare: number; ask: number }>,
  });
  const counts = { prepare: 0, ask: 0 };
  const graph = new StateGraph(state)
    .addNode('prepare', () => {
      counts.prepare++;
      return {};
    })
    .addNode('ask', async (_state, config) => {
      counts.ask++;
      await Promise.resolve();
      return { answer: interactions.request(request, config).payload };
    })
    .addNode('finish', () => ({ counts: { ...counts } }))
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'ask')
    .addEdge('ask', 'finish')
    .addEdge('finish', END)
    .compile({ checkpointer });
  return durability === undefined ? graph : graph.withConfig({ durability });
}

export function factory(...args: Parameters<ConformanceCase['factory']>): ConformanceGraph {
  return createGraph(args);
}
