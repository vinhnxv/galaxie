// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { BaseCheckpointSaver } from '@langchain/langgraph/web';
import type { ConformanceCase, ConformanceGraph, LangGraphModule } from '../support/transcript.js';
import { ask, question } from './idless.js';

export const IDLESS_SHAPES = [
  'supported',
  'nodeInterruptString',
  'nodeInterruptRequest',
  'rawGraphInterrupt',
  'parallelSend',
  'twoInOneNode',
  'childCompiled',
  'bodyChild',
  'mixed',
] as const;
export type IdlessShape = (typeof IDLESS_SHAPES)[number];

export function expectedOutcome(shape: IdlessShape): { code: string; published: number } {
  return shape === 'supported' || shape.startsWith('bodyChild')
    ? { code: 'succeeded', published: 1 }
    : {
        code: 'unsupported',
        published: ['nodeInterruptRequest', 'rawGraphInterrupt', 'twoInOneNode'].includes(shape)
          ? 1
          : 0,
      };
}

export function shapeGraph(
  langgraph: LangGraphModule,
  checkpointer: BaseCheckpointSaver,
  shape: IdlessShape,
  interactions: NonNullable<Parameters<ConformanceCase['factory']>[4]>,
): {
  graph: ConformanceGraph & {
    invoke(input: unknown, config: Parameters<ConformanceGraph['getState']>[0]): Promise<unknown>;
  };
  counts: { parent: number; gate: number; effects: number };
} {
  const { Annotation, StateGraph, START, END, Send, NodeInterrupt, GraphInterrupt } = langgraph;
  const state = Annotation.Root({
    answers: Annotation<unknown[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
    applications: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  });
  const counts = { parent: 0, gate: 0, effects: 0 };
  const gate = async (_: unknown, config: Parameters<typeof ask>[1]) => {
    counts.gate++;
    if (shape === 'nodeInterruptString') throw new NodeInterrupt('message');
    if (shape === 'nodeInterruptRequest') throw new NodeInterrupt(question);
    if (shape === 'rawGraphInterrupt') throw new GraphInterrupt([{ value: question }]);
    const answer = await ask(interactions, config);
    if (shape === 'twoInOneNode')
      await ask(interactions, config, { ...question, viewRevision: 'r2' });
    counts.effects++;
    return { answers: [answer], applications: 1 };
  };
  if (shape === 'childCompiled' || shape.startsWith('bodyChild')) {
    const child = new StateGraph(state)
      .addNode('gate', gate)
      .addEdge(START, 'gate')
      .addEdge('gate', END)
      .compile();
    const parent = new StateGraph(state);
    if (shape === 'childCompiled') {
      const graph = parent
        .addNode('parent', child)
        .addEdge(START, 'parent')
        .addEdge('parent', END)
        .compile({ checkpointer });
      return { graph, counts };
    }
    const graph = parent
      .addNode('parent', async (_, config) => {
        counts.parent++;
        return child.invoke({}, config);
      })
      .addEdge(START, 'parent')
      .addEdge('parent', END)
      .compile({ checkpointer });
    return { graph, counts };
  }
  const builder = new StateGraph(state).addNode('gate', gate);
  if (shape === 'parallelSend' || shape === 'mixed') {
    const graph = builder
      .addNode('bearing', (_, config) => ({
        answers: [interactions.request(question, config)],
        applications: 1,
      }))
      .addConditionalEdges(
        START,
        () => [new Send('gate', {}), new Send(shape === 'mixed' ? 'bearing' : 'gate', {})],
        ['gate', 'bearing'],
      )
      .addEdge('gate', END)
      .addEdge('bearing', END)
      .compile({ checkpointer });
    return { graph, counts };
  }
  return {
    graph: builder.addEdge(START, 'gate').addEdge('gate', END).compile({ checkpointer }),
    counts,
  };
}
