// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ConformanceCase, ConformanceGraph } from '../support/transcript.js';
import { request } from './interrupt-resume.js';

export const input = { value: 1 };
export const script = {};
export const resumes = [{ action: 'submit', payload: 'inner answer' }] as const;

export function factory(...args: Parameters<ConformanceCase['factory']>): ConformanceGraph {
  const [langgraph, , checkpointer, , interactions] = args;
  if (interactions === undefined) throw new Error('The interaction driver is required.');
  const { Annotation, StateGraph, START, END } = langgraph;
  const state = Annotation.Root({
    value: Annotation<number>,
    answer: Annotation<unknown>,
    counts: Annotation<{ callSub: number; s1: number; sask: number }>,
  });
  const counts = { callSub: 0, s1: 0, sask: 0 };
  const child = new StateGraph(state)
    .addNode('s1', () => {
      counts.s1++;
      return {};
    })
    .addNode('sask', async (_state, config) => {
      counts.sask++;
      await Promise.resolve();
      return { answer: interactions.request(request, config).payload };
    })
    .addEdge(START, 's1')
    .addEdge('s1', 'sask')
    .addEdge('sask', END)
    .compile();
  return new StateGraph(state)
    .addNode('callSub', async (value, config) => {
      counts.callSub++;
      return child.invoke(value, config);
    })
    .addNode('finish', () => ({ counts: { ...counts } }))
    .addEdge(START, 'callSub')
    .addEdge('callSub', 'finish')
    .addEdge('finish', END)
    .compile({ checkpointer });
}
