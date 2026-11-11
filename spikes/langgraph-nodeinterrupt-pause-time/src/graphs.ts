// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { RunnableLambda } from '@langchain/core/runnables';
import {
  Annotation,
  type CompiledStateGraph,
  END,
  GraphInterrupt,
  interrupt,
  type LangGraphRunnableConfig,
  NodeInterrupt,
  START,
  StateGraph,
} from '@langchain/langgraph';
import type { MemorySaver } from '@langchain/langgraph-checkpoint';
import { requestInteraction } from '../../../packages/adapter-langgraph/src/interaction.js';

export const DURABILITIES = ['sync', 'async', 'exit'] as const;
export type Durability = (typeof DURABILITIES)[number];
export const SHAPES = [
  'helperIdless',
  'nodeInterruptRequest',
  'rawGraphInterrupt',
  'rawInterruptCall',
  'helperIdBearing',
] as const;
export type Shape = (typeof SHAPES)[number];
export type Helper = (value: unknown, config: LangGraphRunnableConfig) => unknown;

// Same scripted request and answer as tests/conformance/cases/idless.ts.
export const question = {
  surfaceId: 'main',
  viewRevision: 'r1',
  component: 'conformance.Question/v1',
  props: { question: 'Continue?' },
};
export const answer = { action: 'submit', payload: { answer: 'yes' } };

const state = Annotation.Root({ answer: Annotation<unknown> });
type FixtureGraph = CompiledStateGraph<
  typeof state.State,
  typeof state.Update,
  string,
  typeof state.spec,
  typeof state.spec
>;

export function createFixture(
  shape: Shape,
  saver: MemorySaver,
  helper: Helper = requestInteraction,
  thrown?: () => never,
): { graph: FixtureGraph; counts: { gate: number; effects: number } } {
  const counts = { gate: 0, effects: 0 };
  const graph = new StateGraph(state)
    .addNode('gate', async (_, config) => {
      counts.gate++;
      if (thrown !== undefined) return thrown();
      if (shape === 'nodeInterruptRequest') throw new NodeInterrupt(question);
      if (shape === 'rawGraphInterrupt') throw new GraphInterrupt([{ value: question }]);
      let response: unknown;
      if (shape === 'helperIdBearing') response = helper(question, config);
      else {
        await Promise.resolve();
        const configurable = { ...config.configurable };
        delete configurable['checkpoint_ns'];
        response = await RunnableLambda.from((_input, inner) =>
          shape === 'rawInterruptCall' ? interrupt(question) : helper(question, inner),
        ).invoke({}, { ...config, configurable });
      }
      counts.effects++;
      return { answer: response };
    })
    .addEdge(START, 'gate')
    .addEdge('gate', END)
    .compile({ checkpointer: saver });
  return { graph, counts };
}
