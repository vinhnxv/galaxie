// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ConformanceCase, ConformanceGraph } from '../support/transcript.js';

export const identity = 'ordinal';
export const input = { value: 1 };
export const script = {};
export const resumes = [
  { action: 'submit', payload: 'first' },
  { action: 'submit', payload: false },
] as const;
export const questions = [
  {
    surfaceId: 'main',
    viewRevision: 'r1',
    component: 'conformance.Question/v1',
    props: { question: 'First question?' },
  },
  {
    surfaceId: 'main',
    viewRevision: 'r2',
    component: 'conformance.Question/v1',
    props: { question: 'Second question?' },
  },
] as const;

export function factory(...args: Parameters<ConformanceCase['factory']>): ConformanceGraph {
  const [{ Annotation, StateGraph, START, END }, , checkpointer, , interactions] = args;
  if (interactions === undefined) throw new Error('The interaction driver is required.');
  const state = Annotation.Root({
    value: Annotation<number>,
    first: Annotation<unknown>,
    second: Annotation<unknown>,
    executions: Annotation<number>,
  });
  let executions = 0;
  return new StateGraph(state)
    .addNode('askBoth', async (_, config) => {
      executions++;
      await Promise.resolve();
      const first = interactions.request(questions[0], config).payload;
      const second = interactions.request(questions[1], config).payload;
      return { first, second, executions };
    })
    .addEdge(START, 'askBoth')
    .addEdge('askBoth', END)
    .compile({ checkpointer });
}

export const INTERRUPT_TWICE_CASE_NAMES = ['interrupt-twice'] as const;
export const interruptTwiceCases: Readonly<
  Record<(typeof INTERRUPT_TWICE_CASE_NAMES)[number], ConformanceCase>
> = {
  'interrupt-twice': { identity, factory, input, script, resumes },
};
