// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConformanceCase, ConformanceGraph } from '../support/transcript.js';
import { request } from './interrupt-resume.js';

export const input = { value: 1 };
export const script = {};
export const resumes = [
  { action: 'submit', payload: 'first' },
  { action: 'submit', payload: false },
] as const;

export function factory(...args: Parameters<ConformanceCase['factory']>): ConformanceGraph {
  const [langgraph, , checkpointer, , interactions] = args;
  if (interactions === undefined) throw new Error('The interaction driver is required.');
  const { Annotation, StateGraph, START, END } = langgraph;
  const state = Annotation.Root({
    value: Annotation<number>,
    first: Annotation<unknown>,
    second: Annotation<unknown>,
    counts: Annotation<{ askFirst: number; askSecond: number }>,
  });
  const counts = { askFirst: 0, askSecond: 0 };
  return new StateGraph(state)
    .addNode('askFirst', (_state, config) => {
      counts.askFirst++;
      return { first: interactions.request(request, config).payload };
    })
    .addNode('askSecond', (_state, config) => {
      counts.askSecond++;
      return { second: interactions.request(request, config).payload };
    })
    .addNode('finish', () => ({ counts: { ...counts } }))
    .addEdge(START, 'askFirst')
    .addEdge('askFirst', 'askSecond')
    .addEdge('askSecond', 'finish')
    .addEdge('finish', END)
    .compile({ checkpointer });
}
