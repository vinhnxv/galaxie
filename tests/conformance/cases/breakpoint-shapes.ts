// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { ConformanceGraph, LangGraphModule } from '../support/transcript.js';

export const BREAKPOINT_SHAPES = ['before', 'after', 'both', 'wildcard', 'child'] as const;
export type BreakpointShape = (typeof BREAKPOINT_SHAPES)[number];

export function breakpointGraph(
  langgraph: LangGraphModule,
  checkpointer: BaseCheckpointSaver,
  shape: BreakpointShape,
  invisible = false,
): { graph: ConformanceGraph; settings: object; counts: { prepare: number; work: number } } {
  const { Annotation, StateGraph, START, END } = langgraph;
  const state = Annotation.Root({ value: Annotation<number> });
  const counts = { prepare: 0, work: 0 };
  const settings =
    shape === 'child' || shape === 'before'
      ? { interruptBefore: ['work' as const] }
      : shape === 'after'
        ? { interruptAfter: ['prepare' as const] }
        : shape === 'both'
          ? { interruptBefore: ['work' as const], interruptAfter: ['prepare' as const] }
          : { interruptBefore: '*' as const };
  const work = ({ value }: { value: number }) => {
    counts.work++;
    return { value: value + 1 };
  };
  const base = new StateGraph(state)
    .addNode('prepare', () => {
      counts.prepare++;
      return {};
    })
    .addEdge(START, 'prepare');
  let graph: ConformanceGraph;
  if (shape === 'child') {
    const child = new StateGraph(state)
      .addNode('work', work)
      .addEdge(START, 'work')
      .addEdge('work', END)
      .compile(invisible ? {} : { interruptBefore: ['work'] });
    graph = invisible
      ? base
          .addNode('child', (value, config) =>
            child.invoke(value, { ...config, interruptBefore: ['work'] }),
          )
          .addEdge('prepare', 'child')
          .addEdge('child', END)
          .compile({ checkpointer })
      : base
          .addNode('child', child)
          .addEdge('prepare', 'child')
          .addEdge('child', END)
          .compile({ checkpointer });
  } else {
    graph = base
      .addNode('work', work)
      .addEdge('prepare', 'work')
      .addEdge('work', END)
      .compile({ checkpointer, ...(invisible ? {} : settings) });
  }
  if (invisible && shape !== 'child') {
    const compiled = graph;
    graph = {
      stream: compiled.stream.bind(compiled),
      getState: compiled.getState.bind(compiled),
      getStateHistory: compiled.getStateHistory.bind(compiled),
      transform: (input, options) => compiled.transform(input, { ...options, ...settings }),
    };
  }
  return { graph, settings, counts };
}

export function compiledSettings(graph: object): object {
  const source = graph as { interruptBefore?: unknown; interruptAfter?: unknown };
  return {
    interruptBefore: source.interruptBefore ?? null,
    interruptAfter: source.interruptAfter ?? null,
  };
}
