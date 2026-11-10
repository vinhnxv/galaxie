// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ConformanceCase, ConformanceGraph } from '../support/transcript.js';

export const input = { value: 1 };
export const script = {};
export const request = {
  surfaceId: 'main',
  viewRevision: 'r1',
  component: 'conformance.Gate/v1',
  props: { question: 'Continue?' },
};

export function factory(...args: Parameters<ConformanceCase['factory']>): ConformanceGraph {
  const [langgraph, , checkpointer, , interactions] = args;
  if (interactions === undefined) throw new Error('The interaction driver is required.');
  const { Annotation, StateGraph, START, END } = langgraph;
  const state = Annotation.Root({
    value: Annotation<number>,
    decision: Annotation<string>,
    counts: Annotation<{ prepare: number; work: number }>,
  });
  const counts = { prepare: 0, work: 0 };
  return new StateGraph(state)
    .addNode('prepare', () => {
      counts.prepare++;
      return {};
    })
    .addNode('gate', async (_state, config) => {
      await Promise.resolve();
      return { decision: interactions.request(request, config).action };
    })
    .addNode('work', ({ value }) => {
      counts.work++;
      return { value: value + 1 };
    })
    .addNode('finish', () => ({ counts: { ...counts } }))
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'gate')
    .addConditionalEdges('gate', ({ decision }) => (decision === 'reject' ? END : 'work'))
    .addEdge('work', 'finish')
    .addEdge('finish', END)
    .compile({ checkpointer });
}
