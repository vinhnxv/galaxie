// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { RunnableConfig } from '@langchain/core/runnables';
import {
  Annotation,
  type CompiledStateGraph,
  END,
  interrupt,
  Send,
  START,
  StateGraph,
} from '@langchain/langgraph';
import type { MemorySaver } from '@langchain/langgraph-checkpoint';

export const DURABILITIES = ['sync', 'async', 'exit'] as const;
export type Durability = (typeof DURABILITIES)[number];
export type FixtureKind =
  | 'twice'
  | 'fanout'
  | 'fanout3'
  | 'sendFanout'
  | 'quietSibling'
  | 'childTwice';
export type Counts = Record<string, number>;

export interface FixtureOptions {
  readonly beforeAsk?: (name: string, config: RunnableConfig) => Promise<void>;
  readonly afterFirst?: (answer: unknown, config: RunnableConfig) => Promise<void>;
}

export interface QuestionRequest {
  readonly surfaceId: string;
  readonly viewRevision: string;
  readonly component: string;
  readonly props: { readonly question: string };
}

export function question(name: string): QuestionRequest {
  return {
    surfaceId: 'main',
    viewRevision: `revision-${name}`,
    component: 'spike.Question/v1',
    props: { question: name },
  };
}

const state = Annotation.Root({
  answers: Annotation<Record<string, unknown>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  branch: Annotation<string>,
});

export type FixtureGraph = CompiledStateGraph<
  typeof state.State,
  typeof state.Update,
  string,
  typeof state.spec,
  typeof state.spec
>;

function buildFixture(
  kind: FixtureKind,
  saver: MemorySaver,
  options: FixtureOptions,
): { readonly graph: FixtureGraph; readonly counts: Counts } {
  const counts: Counts = {};
  const prefix = async (name: string, config: RunnableConfig): Promise<void> => {
    counts[name] = (counts[name] ?? 0) + 1;
    await options.beforeAsk?.(name, config);
  };
  const twice = async (_value: typeof state.State, config: RunnableConfig) => {
    await prefix('twice', config);
    const first: unknown = interrupt(question('first'));
    await options.afterFirst?.(first, config);
    const second: unknown = interrupt(question('second'));
    return { answers: { first, second } };
  };
  const ask = (name: string) => async (_value: typeof state.State, config: RunnableConfig) => {
    await prefix(name, config);
    const answer: unknown = interrupt(question(name));
    return { answers: { [name]: answer } };
  };
  const join = () => {
    counts['join'] = (counts['join'] ?? 0) + 1;
    return {};
  };
  if (kind === 'twice') {
    const graph = new StateGraph(state)
      .addNode('twice', twice)
      .addEdge(START, 'twice')
      .addEdge('twice', END)
      .compile({ checkpointer: saver });
    return { graph, counts };
  }
  if (kind === 'childTwice') {
    const child = new StateGraph(state)
      .addNode('twice', twice)
      .addEdge(START, 'twice')
      .addEdge('twice', END)
      .compile();
    const graph = new StateGraph(state)
      .addNode('parent', async (value, config) => {
        await prefix('parent', config);
        return child.invoke(value, config);
      })
      .addEdge(START, 'parent')
      .addEdge('parent', END)
      .compile({ checkpointer: saver });
    return { graph, counts };
  }
  if (kind === 'sendFanout') {
    const graph = new StateGraph(state)
      .addNode('ask', async (value, config) => {
        const name = value.branch;
        await prefix(name, config);
        const answer: unknown = interrupt(question(name));
        return { answers: { [name]: answer } };
      })
      .addNode('join', join)
      .addConditionalEdges(START, () => [
        new Send('ask', { branch: 'askA' }),
        new Send('ask', { branch: 'askB' }),
      ])
      .addEdge('ask', 'join')
      .addEdge('join', END)
      .compile({ checkpointer: saver });
    return { graph, counts };
  }
  if (kind === 'quietSibling') {
    const graph = new StateGraph(state)
      .addNode('askA', ask('askA'))
      .addNode('noteB', async (_value, config) => {
        await prefix('noteB', config);
        interrupt(question('noteB'));
        return {};
      })
      .addEdge(START, 'askA')
      .addEdge(START, 'noteB')
      .addEdge('askA', END)
      .addEdge('noteB', END)
      .compile({ checkpointer: saver });
    return { graph, counts };
  }
  if (kind === 'fanout3') {
    const graph = new StateGraph(state)
      .addNode('askA', ask('askA'))
      .addNode('askB', ask('askB'))
      .addNode('askC', ask('askC'))
      .addNode('join', join)
      .addEdge(START, 'askA')
      .addEdge(START, 'askB')
      .addEdge(START, 'askC')
      .addEdge(['askA', 'askB', 'askC'], 'join')
      .addEdge('join', END)
      .compile({ checkpointer: saver });
    return { graph, counts };
  }
  const graph = new StateGraph(state)
    .addNode('askA', ask('askA'))
    .addNode('askB', ask('askB'))
    .addNode('join', join)
    .addEdge(START, 'askA')
    .addEdge(START, 'askB')
    .addEdge(['askA', 'askB'], 'join')
    .addEdge('join', END)
    .compile({ checkpointer: saver });
  return { graph, counts };
}

export function createFixture(
  kind: FixtureKind,
  saver: MemorySaver,
  options: FixtureOptions = {},
): ReturnType<typeof buildFixture> {
  return buildFixture(kind, saver, options);
}
