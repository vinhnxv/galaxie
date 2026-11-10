// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type RunnableConfig, RunnableLambda } from '@langchain/core/runnables';
import {
  Annotation,
  type CompiledStateGraph,
  END,
  GraphInterrupt,
  NodeInterrupt,
  Send,
  START,
  StateGraph,
} from '@langchain/langgraph';
import type { MemorySaver } from '@langchain/langgraph-checkpoint';
import { requestInteraction } from '../../../packages/adapter-langgraph/src/interaction.js';

export const DURABILITIES = ['sync', 'async', 'exit'] as const;
export type Durability = (typeof DURABILITIES)[number];
export type FixtureKind =
  | 'before'
  | 'after'
  | 'both'
  | 'loop'
  | 'fanoutOne'
  | 'fanoutBoth'
  | 'wildcard'
  | 'mixed'
  | 'child'
  | 'failing'
  | 'gate'
  | 'nodeInterrupt'
  | 'rawInterrupt'
  | 'strippedNamespace'
  | 'strippedSend'
  | 'dynamic'
  | 'send'
  | 'dynamicChild'
  | 'plain';
export type Counts = Record<string, number>;
export interface FixtureOptions {
  readonly node?: string;
  readonly beforeNode?: (name: string, config: RunnableConfig) => Promise<void>;
}

export function question(node: string): {
  surfaceId: string;
  viewRevision: string;
  component: 'spike.Breakpoint/v1';
  props: { node: string; kind: string };
} {
  return {
    surfaceId: 'breakpoint',
    viewRevision: `gate-${node}`,
    component: 'spike.Breakpoint/v1',
    props: { node, kind: 'before' },
  };
}

const state = Annotation.Root({
  trace: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  visits: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  answer: Annotation<unknown>({ reducer: (_left, right) => right }),
  privateValue: Annotation<string>,
});
export type FixtureGraph = CompiledStateGraph<
  typeof state.State,
  typeof state.Update,
  string,
  typeof state.spec,
  typeof state.spec
>;

export function createFixture(
  kind: FixtureKind,
  saver: MemorySaver,
  options: FixtureOptions = {},
): { graph: FixtureGraph; counts: Counts } {
  const counts: Counts = {};
  const prefix = async (name: string, config: RunnableConfig): Promise<void> => {
    counts[name] = (counts[name] ?? 0) + 1;
    await options.beforeNode?.(name, config);
  };
  const node = (name: string) => async (_value: typeof state.State, config: RunnableConfig) => {
    await prefix(name, config);
    if (kind === 'failing' && name === 'work') throw new Error('Scripted failure.');
    return { trace: [name], visits: name === 'work' ? 1 : 0 };
  };
  const ask = async (_value: typeof state.State, config: RunnableConfig) => {
    await prefix('gate', config);
    let answer: unknown;
    if (kind === 'nodeInterrupt') throw new NodeInterrupt('m');
    if (kind === 'rawInterrupt') throw new GraphInterrupt([{ value: question('work') }]);
    if (kind === 'strippedNamespace' || kind === 'strippedSend') {
      const configurable = { ...config.configurable };
      delete configurable['checkpoint_ns'];
      const inner = RunnableLambda.from((_input, innerConfig) =>
        requestInteraction(question('work'), innerConfig),
      );
      answer = await inner.invoke({}, { ...config, configurable });
    } else answer = requestInteraction(question('work'), config);
    return { answer, trace: [kind === 'strippedSend' ? `gate:${JSON.stringify(answer)}` : 'gate'] };
  };
  if (
    [
      'nodeInterrupt',
      'rawInterrupt',
      'strippedNamespace',
      'strippedSend',
      'dynamic',
      'send',
      'dynamicChild',
    ].includes(kind)
  ) {
    const child =
      kind === 'dynamicChild'
        ? new StateGraph(state)
            .addNode('gate', ask)
            .addEdge(START, 'gate')
            .addEdge('gate', END)
            .compile()
        : ask;
    const g = new StateGraph(state).addNode(
      kind === 'dynamicChild' ? 'child' : 'gate',
      kind === 'dynamicChild' ? child : ask,
    );
    if (kind === 'send' || kind === 'strippedSend')
      g.addConditionalEdges(START, () => [new Send('gate', {}), new Send('gate', {})]);
    else g.addEdge(START, kind === 'dynamicChild' ? 'child' : 'gate');
    g.addEdge(kind === 'dynamicChild' ? 'child' : 'gate', END);
    return { graph: g.compile({ checkpointer: saver }), counts };
  }
  if (kind === 'child') {
    const child = new StateGraph(state)
      .addNode('work', node('work'))
      .addEdge(START, 'work')
      .addEdge('work', END)
      .compile({ interruptBefore: ['work'] });
    return {
      graph: new StateGraph(state)
        .addNode('child', child)
        .addEdge(START, 'child')
        .addEdge('child', END)
        .compile({ checkpointer: saver }),
      counts,
    };
  }
  if (kind === 'fanoutOne' || kind === 'fanoutBoth') {
    return {
      graph: new StateGraph(state)
        .addNode('a', node('a'))
        .addNode('b', node('b'))
        .addEdge(START, 'a')
        .addEdge(START, 'b')
        .addEdge('a', END)
        .addEdge('b', END)
        .compile({
          checkpointer: saver,
          interruptBefore: kind === 'fanoutOne' ? ['a'] : ['a', 'b'],
        }),
      counts,
    };
  }
  const work = options.node ?? 'work';
  const g = new StateGraph(state)
    .addNode('prepare', node('prepare'))
    .addNode(work, node(work))
    .addNode('finish', node('finish'))
    .addEdge(START, 'prepare')
    .addEdge('finish', END);
  if (kind === 'gate' || kind === 'mixed') g.addNode('gate', ask);
  if (kind === 'gate') {
    g.addEdge('prepare', 'gate').addConditionalEdges('gate', (value) =>
      (value.answer as { action?: string })?.action === 'reject' ? END : work,
    );
  } else if (kind === 'mixed') g.addEdge('prepare', 'gate').addEdge('gate', work);
  else g.addEdge('prepare', work);
  if (kind === 'loop') g.addConditionalEdges(work, (value) => (value.visits < 2 ? work : 'finish'));
  else g.addEdge(work, 'finish');
  let interruptBefore: '*' | string[] | undefined;
  if (kind === 'wildcard') interruptBefore = '*';
  else if (['before', 'both', 'loop'].includes(kind)) interruptBefore = [work];
  else if (kind === 'mixed') interruptBefore = ['gate'];
  const interruptAfter = ['after', 'both'].includes(kind) ? ['prepare'] : undefined;
  return {
    graph: g.compile({
      checkpointer: saver,
      ...(interruptBefore === undefined ? {} : { interruptBefore }),
      ...(interruptAfter === undefined ? {} : { interruptAfter }),
    }),
    counts,
  };
}
